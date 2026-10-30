#!/usr/bin/env node
import { loadEnv } from './env.js'
import { runCli } from './run.js'

// Load `.env` (or `--env-file`) before anything reads configuration. Real
// environment variables win, so `MUNGIL_USER_PASSWORD=... npx mungilbase ...`
// keeps working.
loadEnv(process.argv.slice(2))

const exitCode = await runCli(process.argv.slice(2))
if (exitCode !== 0) process.exitCode = exitCode
