import type { MungilConfig } from '../config/schema.js'

export interface OAuthProfile {
  provider: 'google' | 'github'
  providerUserId: string
  email: string
  /** Only profiles with a provider-verified email are accepted. */
  emailVerified: boolean
}

export interface OAuthProvider {
  name: 'google' | 'github'
  authorizationUrl(state: string, redirectUri: string): string
  exchange(code: string, redirectUri: string): Promise<OAuthProfile>
}

export type OAuthProviders = Map<string, OAuthProvider>

export class OAuthError extends Error {
  override readonly name = 'OAuthError'
  constructor(readonly code: string, message = code) {
    super(message)
  }
}

export function oauthRedirectUri(
  appUrl: string,
  provider: 'google' | 'github',
  callbackUrl?: string,
): string {
  return callbackUrl ?? `${appUrl.replace(/\/+$/, '')}/api/v1/auth/oauth/${provider}/callback`
}

/**
 * Builds provider clients from config. Missing client secrets fail at boot
 * rather than on the first login attempt.
 */
export function createOAuthProviders(
  config: MungilConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): OAuthProviders {
  const providers: OAuthProviders = new Map()
  const oauth = config.auth?.oauth
  if (!oauth) return providers

  const appUrl = config.appUrl
  if (!appUrl) throw new Error('OAuth requires appUrl')

  if (oauth.google) {
    const secret = env[oauth.google.clientSecretEnv]
    if (!secret) throw new Error(`Missing Google OAuth secret in ${oauth.google.clientSecretEnv}`)
    providers.set(
      'google',
      googleProvider(oauth.google.clientId, secret, fetchImpl),
    )
  }

  if (oauth.github) {
    const secret = env[oauth.github.clientSecretEnv]
    if (!secret) throw new Error(`Missing GitHub OAuth secret in ${oauth.github.clientSecretEnv}`)
    providers.set(
      'github',
      githubProvider(oauth.github.clientId, secret, fetchImpl),
    )
  }

  return providers
}

function googleProvider(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): OAuthProvider {
  return {
    name: 'google',
    authorizationUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      })
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    },
    async exchange(code, redirectUri) {
      const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      })
      if (!tokenResponse.ok) throw new OAuthError('token_exchange_failed')

      const token = (await tokenResponse.json()) as { access_token?: string }
      if (!token.access_token) throw new OAuthError('token_exchange_failed')

      const profileResponse = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}` },
      })
      if (!profileResponse.ok) throw new OAuthError('profile_fetch_failed')

      const profile = (await profileResponse.json()) as {
        sub?: string
        email?: string
        email_verified?: boolean
      }
      if (!profile.sub || !profile.email) throw new OAuthError('profile_missing_email')

      return {
        provider: 'google',
        providerUserId: profile.sub,
        email: profile.email,
        emailVerified: profile.email_verified === true,
      }
    },
  }
}

function githubProvider(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): OAuthProvider {
  return {
    name: 'github',
    authorizationUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      })
      return `https://github.com/login/oauth/authorize?${params.toString()}`
    },
    async exchange(code, redirectUri) {
      const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }).toString(),
      })
      if (!tokenResponse.ok) throw new OAuthError('token_exchange_failed')

      const token = (await tokenResponse.json()) as { access_token?: string }
      if (!token.access_token) throw new OAuthError('token_exchange_failed')

      const headers = {
        authorization: `Bearer ${token.access_token}`,
        accept: 'application/json',
        'user-agent': 'mungilbase',
      }

      const userResponse = await fetchImpl('https://api.github.com/user', { headers })
      if (!userResponse.ok) throw new OAuthError('profile_fetch_failed')
      const user = (await userResponse.json()) as { id?: number }
      if (!user.id) throw new OAuthError('profile_fetch_failed')

      // `/user.email` can be unverified or hidden; only trust the emails list.
      const emailsResponse = await fetchImpl('https://api.github.com/user/emails', { headers })
      if (!emailsResponse.ok) throw new OAuthError('profile_missing_email')

      const emails = (await emailsResponse.json()) as {
        email: string
        primary: boolean
        verified: boolean
      }[]
      const chosen =
        emails.find((candidate) => candidate.primary && candidate.verified) ??
        emails.find((candidate) => candidate.verified)
      if (!chosen) throw new OAuthError('profile_missing_email')

      return {
        provider: 'github',
        providerUserId: String(user.id),
        email: chosen.email,
        emailVerified: true,
      }
    },
  }
}
