import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'

/**
 * OWASP baseline for Argon2id: 19 MiB, 2 iterations, 1 lane.
 * Roughly 40–60 ms per hash on a small VPS, which is the point.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function normalizePassword(password: string): string {
  return password.normalize('NFKC')
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(normalizePassword(password), ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, normalizePassword(password))
  } catch {
    // A corrupt or foreign hash must read as "wrong password", not as a 500.
    return false
  }
}

let dummyHash: Promise<string> | null = null

/**
 * Spends the same work as a real verification for an unknown account, so
 * "no such user" and "wrong password" take comparable time.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword('mungilbase-dummy-password')
  await verifyPassword(await dummyHash, password)
  return false
}
