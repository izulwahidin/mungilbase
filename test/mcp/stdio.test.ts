import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { init } from '../../src/cli/init.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const directories: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-stdio-'))
  directories.push(directory)
  return directory
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

interface Harness {
  child: ChildProcessWithoutNullStreams
  lines: string[]
  stderr: () => string
  next: (predicate: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>
}

function startMcp(configPath: string): Harness {
  // Spawn the real CLI over a real pipe: this is the only test that can catch
  // stdout pollution or a broken stdio handshake.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', 'mcp', '--config', configPath],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(child)

  const lines: string[] = []
  const errors: string[] = []
  let buffer = ''
  let stderrText = ''
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean
    resolve: (message: Record<string, unknown>) => void
    reject: (error: Error) => void
  }> = []

  const deliver = (message: Record<string, unknown>): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!
      if (waiter.predicate(message)) {
        waiters.splice(index, 1)
        waiter.resolve(message)
      }
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        lines.push(line)
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
          errors.push(`stdout carried a non-JSON-RPC line: ${line.slice(0, 200)}`)
          continue
        }
        deliver(parsed)
      }
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })

  const next = (
    predicate: (message: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (errors.length) {
        reject(new Error(errors[0]))
        return
      }
      const existing = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(predicate)
      if (existing) {
        resolve(existing)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for a response. stderr: ${stderrText.slice(0, 500)}`))
      }, 30_000)
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject,
      })
    })

  return { child, lines, stderr: () => stderrText, next }
}

describe('mcp over stdio', () => {
  it('answers initialize and tools/list, and keeps stdout protocol-only', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    const harness = startMcp(join(directory, 'mungil.config.ts'))

    harness.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mungilbase-test', version: '1.0.0' },
        },
      })}\n`,
    )

    const initialized = (await harness.next((message) => message.id === 1)) as {
      result?: { serverInfo?: { name?: string } }
    }
    expect(initialized.result?.serverInfo?.name).toBe('mungilbase')

    harness.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    harness.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    )

    const listed = (await harness.next((message) => message.id === 2)) as {
      result?: { tools?: Array<{ name: string; outputSchema?: unknown }> }
    }
    const tools = listed.result?.tools ?? []
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['whoami', 'list_rows', 'create_row', 'delete_row']),
    )

    // Every line on stdout parsed as JSON-RPC (the harness throws otherwise),
    // and diagnostics stay on stderr.
    expect(harness.lines.every((line) => line.startsWith('{'))).toBe(true)
    expect(harness.stderr()).toContain('"event":"mcp_ready"')
    expect(harness.stderr()).toContain('demo@example.com')

    harness.child.kill('SIGTERM')
  }, 60_000)
})
