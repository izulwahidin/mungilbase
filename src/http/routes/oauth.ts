import { timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../app.js'
import type { AuthService } from '../../auth/service.js'
import { oauthRedirectUri, OAuthError, type OAuthProvider, type OAuthProviders } from '../../auth/oauth.js'
import { createToken } from '../../auth/tokens.js'
import { recordAudit } from '../../audit/log.js'
import type { MungilConfig } from '../../config/schema.js'
import type { Db } from '../../db/connect.js'
import { notFound } from '../errors.js'

const STATE_COOKIE = 'mungil_oauth_state'
const STATE_TTL_SECONDS = 600
const STATE_PATH = '/api/v1/auth/oauth'

export interface OAuthRoutesDeps {
  service: AuthService
  db: Db
  config: MungilConfig
  providers: OAuthProviders
}

export function registerOAuthRoutes(app: Hono<AppEnv>, deps: OAuthRoutesDeps): void {
  const appUrl = deps.config.appUrl
  if (!appUrl) return

  const secure = appUrl.startsWith('https://')
  const successRedirect = `${appUrl.replace(/\/+$/, '')}/auth/callback`

  app.get('/api/v1/auth/oauth/:provider/start', (c) => {
    const provider = deps.providers.get(c.req.param('provider'))
    if (!provider) throw notFound('Unknown OAuth provider')

    const state = createToken()
    setCookie(c, STATE_COOKIE, `${provider.name}:${state}`, {
      path: STATE_PATH,
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      maxAge: STATE_TTL_SECONDS,
    })

    return c.redirect(provider.authorizationUrl(state, redirectUri(provider, deps.config, appUrl)), 302)
  })

  app.get('/api/v1/auth/oauth/:provider/callback', async (c) => {
    const provider = deps.providers.get(c.req.param('provider'))
    deleteCookie(c, STATE_COOKIE, { path: STATE_PATH })

    if (!provider) return failure(c, successRedirect, 'unknown_provider')

    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    if (!code || !validState(getCookie(c, STATE_COOKIE), provider.name, state)) {
      return failure(c, successRedirect, 'invalid_state')
    }
    if (c.req.query('error')) return failure(c, successRedirect, 'access_denied')

    try {
      const profile = await provider.exchange(code, redirectUri(provider, deps.config, appUrl))
      if (!profile.emailVerified) throw new OAuthError('email_not_verified')

      const user = await deps.service.findOrCreateOAuthUser(profile.email)
      const session = await deps.service.startSession(user)

      recordAudit(deps.db, {
        event: 'auth.oauth_login',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: user.id,
        metadata: { provider: provider.name },
      })

      const fragment = new URLSearchParams({
        access_token: session.tokens.accessToken,
        refresh_token: session.tokens.refreshToken,
        expires_in: String(
          Math.max(
            0,
            Math.round(
              (Date.parse(session.tokens.accessTokenExpiresAt) - Date.now()) / 1000,
            ),
          ),
        ),
        token_type: 'Bearer',
      })

      return c.redirect(`${successRedirect}#${fragment.toString()}`, 302)
    } catch (error) {
      if (error instanceof OAuthError) {
        return failure(c, successRedirect, error.code)
      }
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'oauth_callback_failed',
          provider: provider.name,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      return failure(c, successRedirect, 'server_error')
    }
  })
}

function failure(c: Parameters<typeof getCookie>[0], successRedirect: string, reason: string) {
  return c.redirect(`${successRedirect}#error=${encodeURIComponent(reason)}`, 302)
}

function validState(cookie: string | undefined, provider: string, state: string): boolean {
  if (!cookie || !state) return false
  const [cookieProvider, cookieState] = cookie.split(':', 2)
  if (cookieProvider !== provider || !cookieState) return false

  const a = Buffer.from(cookieState)
  const b = Buffer.from(state)
  return a.length === b.length && timingSafeEqual(a, b)
}

function redirectUri(provider: OAuthProvider, config: MungilConfig, appUrl: string): string {
  const callback = config.auth?.oauth?.[provider.name]?.callbackUrl
  return oauthRedirectUri(appUrl, provider.name, callback)
}
