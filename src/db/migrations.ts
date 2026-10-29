import type { Migration } from './migrator.js'

/**
 * Application migrations, applied in order by `npm run migrate` and on boot.
 *
 * Week 3 adds the generated table DDL here. Until then this is empty, and the
 * migrator still creates its own bookkeeping table so the mechanism is live
 * and tested from day one.
 */
export const migrations: readonly Migration[] = []
