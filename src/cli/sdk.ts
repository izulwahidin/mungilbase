import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadConfig } from '../config/load.js'
import { generateSdk } from '../sdk/generate.js'

// Usage:
//   npm run sdk
//   npm run sdk -- ./mungil.config.ts ./sdk/mungil-client.ts
const configPath = process.argv[2] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'
const outPath = process.argv[3] ?? './sdk/mungil-client.ts'

const config = await loadConfig(configPath)
const code = generateSdk(config, { version: process.env.MUNGIL_VERSION })

await mkdir(dirname(resolve(outPath)), { recursive: true })
await writeFile(resolve(outPath), code, 'utf8')

console.log(
  JSON.stringify({
    level: 'info',
    event: 'sdk_generated',
    config: resolve(configPath),
    output: resolve(outPath),
    bytes: Buffer.byteLength(code, 'utf8'),
  }),
)
