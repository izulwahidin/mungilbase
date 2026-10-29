import { describe, expect, it } from 'vitest'
import {
  ARGON2_OPTIONS,
  hashPassword,
  normalizePassword,
  verifyDummyPassword,
  verifyPassword,
} from '../../src/auth/password.js'

describe('password hashing', () => {
  it('produces versioned argon2id hashes', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$v=19\$/)
    expect(hash).toContain(`m=${ARGON2_OPTIONS.memoryCost}`)
    expect(hash).toContain(`t=${ARGON2_OPTIONS.timeCost}`)
    expect(hash).not.toContain('correct horse')
  })

  it('uses a fresh salt every time', async () => {
    const first = await hashPassword('same password')
    const second = await hashPassword('same password')
    expect(first).not.toBe(second)
  })

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('right')
    expect(await verifyPassword(hash, 'right')).toBe(true)
    expect(await verifyPassword(hash, 'wrong')).toBe(false)
    expect(await verifyPassword(hash, '')).toBe(false)
    expect(await verifyPassword('not-a-hash', 'right')).toBe(false)
  })

  it('treats unicode normalization consistently', async () => {
    const composed = 'café-au-lait'
    const decomposed = composed.normalize('NFD')
    expect(normalizePassword(decomposed)).toBe(normalizePassword(composed))

    const hash = await hashPassword(composed)
    expect(await verifyPassword(hash, decomposed)).toBe(true)
  })

  it('always fails the dummy verification', async () => {
    expect(await verifyDummyPassword('anything')).toBe(false)
    expect(await verifyDummyPassword('anything')).toBe(false)
  })
})
