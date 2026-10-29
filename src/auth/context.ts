/**
 * What the rest of the app is allowed to know about the caller.
 *
 * Week 7 replaces the transport (JWT verification, sessions) but not this
 * shape. Rules compile against `uid`; nothing else is exposed to them.
 */
export interface AuthContext {
  uid: string | null
  /** Present when the request carried a valid access token. */
  sessionId?: string | null
}

export const anonymous: AuthContext = { uid: null }
