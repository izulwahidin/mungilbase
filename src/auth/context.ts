/**
 * What the rest of the app is allowed to know about the caller.
 *
 * Week 7 replaces the transport (JWT verification, sessions) but not this
 * shape. Rules compile against `uid`; nothing else is exposed to them.
 */
import type { AuthRole } from './roles.js'

export interface AuthContext {
  uid: string | null
  /** Present when the request carried a valid access token. */
  sessionId?: string | null
  role?: AuthRole | null
  /** True when the account's email address is verified. */
  verified?: boolean
  /**
   * True only for an admin when `auth.adminBypassRules` is enabled. A role
   * alone never disables table rules.
   */
  admin?: boolean
}

export const anonymous: AuthContext = { uid: null, role: null, verified: false, admin: false }
