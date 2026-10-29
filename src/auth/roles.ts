/** Closed set. Rules and bypass logic must never do substring matching. */
export const AUTH_ROLES = ['user', 'admin'] as const

export type AuthRole = (typeof AUTH_ROLES)[number]

export function isAuthRole(value: unknown): value is AuthRole {
  return typeof value === 'string' && (AUTH_ROLES as readonly string[]).includes(value)
}
