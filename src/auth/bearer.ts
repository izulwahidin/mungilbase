const BEARER = /^Bearer\s+([A-Za-z0-9_-]{43})$/i

/** Returns the token from an Authorization header, or null. Never throws. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = BEARER.exec(header.trim())
  return match?.[1] ?? null
}
