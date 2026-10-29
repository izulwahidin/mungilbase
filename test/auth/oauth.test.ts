import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { createOAuthProviders, OAuthError } from '../../src/auth/oauth.js'

const config = configSchema.parse({
  appUrl: 'https://api.example.com',
  auth: {
    oauth: {
      google: { clientId: 'google-id' },
      github: { clientId: 'github-id' },
    },
  },
  tables: [],
})

const env = {
  MUNGIL_GOOGLE_CLIENT_SECRET: 'google-secret',
  MUNGIL_GITHUB_CLIENT_SECRET: 'github-secret',
}

function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createOAuthProviders', () => {
  it('fails at boot when a client secret is missing', () => {
    expect(() => createOAuthProviders(config, {})).toThrow(/GOOGLE_CLIENT_SECRET|GOOGLE OAuth secret/)
  })

  it('builds authorization URLs with state and callback', () => {
    const providers = createOAuthProviders(config, env)
    const google = providers.get('google')!
    const url = new URL(google.authorizationUrl('state-1', 'https://api.example.com/cb'))

    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('client_id')).toBe('google-id')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.com/cb')
  })

  it('exchanges a Google code for a verified profile', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (String(url).includes('token')) return jsonBody({ access_token: 'at' })
      if (String(url).includes('userinfo')) {
        return jsonBody({ sub: 'google-user', email: 'user@example.com', email_verified: true })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const providers = createOAuthProviders(config, env, fakeFetch)
    const profile = await providers.get('google')!.exchange('code', 'https://api.example.com/cb')

    expect(profile).toEqual({
      provider: 'google',
      providerUserId: 'google-user',
      email: 'user@example.com',
      emailVerified: true,
    })
    expect(calls[0]).toContain('oauth2.googleapis.com/token')
  })

  it('uses a verified primary GitHub email, never an unverified one', async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('login/oauth/access_token')) return jsonBody({ access_token: 'at' })
      if (target.endsWith('/user')) return jsonBody({ id: 9, email: null })
      if (target.endsWith('/user/emails')) {
        return jsonBody([
          { email: 'unverified@example.com', primary: false, verified: false },
          { email: 'verified@example.com', primary: true, verified: true },
        ])
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const providers = createOAuthProviders(config, env, fakeFetch)
    const profile = await providers.get('github')!.exchange('code', 'https://api.example.com/cb')

    expect(profile).toEqual({
      provider: 'github',
      providerUserId: '9',
      email: 'verified@example.com',
      emailVerified: true,
    })
  })

  it('rejects GitHub accounts without a verified email', async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('login/oauth/access_token')) return jsonBody({ access_token: 'at' })
      if (target.endsWith('/user')) return jsonBody({ id: 9 })
      if (target.endsWith('/user/emails')) {
        return jsonBody([{ email: 'unverified@example.com', primary: true, verified: false }])
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const providers = createOAuthProviders(config, env, fakeFetch)
    await expect(providers.get('github')!.exchange('code', 'https://api.example.com/cb')).rejects.toThrow(
      OAuthError,
    )
  })
})
