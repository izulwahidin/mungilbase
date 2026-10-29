import { createHash, randomBytes } from 'node:crypto'

const TOKEN_BYTES = 32

/** 256 bits of entropy, base64url (43 characters). */
export function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Tokens are stored as SHA-256 hashes.
 *
 * A database leak must not hand the attacker live sessions. Plain SHA-256 is
 * correct here (unlike passwords): the input is 256 random bits, so brute
 * force is infeasible and no work factor is needed or desirable.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Format check before touching the database. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}
