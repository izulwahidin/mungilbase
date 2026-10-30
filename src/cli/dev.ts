import { watch, type FSWatcher } from 'node:fs'
import { findConfigPath } from '../config/load.js'
import { startServer, type RunningServer } from '../server.js'
import { gen } from './commands.js'

export interface DevOptions {
  configPath?: string
  host?: string
  port?: number
}

/**
 * Development loop: boot the server, generate `openapi.json` and the SDK from
 * the current config, then restart both when the config file changes.
 */
export async function dev(options: DevOptions = {}): Promise<void> {
  const configPath = findConfigPath(options.configPath)
  let running: RunningServer | null = null
  let watcher: FSWatcher | null = null
  let restarting = false
  let timer: NodeJS.Timeout | null = null
  let stopping = false

  const boot = async (): Promise<void> => {
    running = await startServer({
      configPath,
      host: options.host,
      port: options.port,
      handleSignals: false,
    })
    await gen({ configPath }).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'generate_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    })
  }

  const restart = async (): Promise<void> => {
    if (restarting || stopping) return
    restarting = true
    try {
      await running?.close()
      running = null
      await boot()
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'dev_restart_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      restarting = false
    }
  }

  await boot()
  console.log(`Watching ${configPath} — press Ctrl+C to stop`)

  watcher = watch(configPath, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void restart()
    }, 250)
  })

  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      if (stopping) return
      stopping = true
      if (timer) clearTimeout(timer)
      watcher?.close()
      console.log(JSON.stringify({ level: 'info', event: 'dev_stop', signal }))
      void (running?.close() ?? Promise.resolve()).finally(() => resolve())
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
}
