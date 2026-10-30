import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { init } from '../../src/cli/init.js'
import { runCli } from '../../src/cli/run.js'
import { VERSION } from '../../src/version.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-cli-'))
  directories.push(directory)
  return directory
}

function capture(): { lines: string[]; io: { log(message: string): void; error(message: string): void } } {
  const lines: string[] = []
  return {
    lines,
    io: {
      log: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('mungilbase CLI', () => {
  it('prints help with no side effects', async () => {
    const { lines, io } = capture()
    expect(await runCli(['--help'], io)).toBe(0)
    expect(lines.join('\n')).toContain(`mungilbase ${VERSION}`)
    expect(lines.join('\n')).toContain('user create <email>')
  })

  it('rejects an unknown command with exit code 2', async () => {
    const { lines, io } = capture()
    expect(await runCli(['frobnicate'], io)).toBe(2)
    expect(lines.join('\n')).toContain('unknown command "frobnicate"')
  })

  it('validates a generated config with doctor', async () => {
    const directory = await workspace()
    await init({ directory })
    const { io } = capture()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      const code = await runCli(['doctor', '--config', join(directory, 'mungil.config.ts')], io)
      expect(code).toBe(0)
      expect(output).toHaveBeenCalledWith(`MungilBase ${VERSION}`)
      expect(output.mock.calls.flat().join('\n')).toContain('notes (4 fields)')
    } finally {
      output.mockRestore()
    }
  })

  it('reports an invalid config without a stack trace', async () => {
    const directory = await workspace()
    const configPath = join(directory, 'mungil.config.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(configPath, JSON.stringify({ tables: [{ name: 'Bad Name' }] }), 'utf8')

    const { lines, io } = capture()
    expect(await runCli(['doctor', '--config', configPath], io)).toBe(1)
    expect(lines.join('\n')).toContain('Invalid config')
  })

  it('creates an account with --generate-password and prints the password once', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { lines, io } = capture()

    try {
      const code = await runCli(
        [
          'user',
          'create',
          'agent@example.com',
          '--generate-password',
          '--config',
          join(directory, 'mungil.config.ts'),
        ],
        io,
      )
      expect(code).toBe(0)
      const output = [...log.mock.calls.flat(), ...lines].join('\n')
      expect(output).toContain('<agent@example.com>')
      expect(output).toMatch(/Password  \S{20,}/)
      expect(output).toContain('Shown once')
    } finally {
      log.mockRestore()
    }
  })

  it('rejects conflicting password sources', async () => {
    const { lines, io } = capture()
    expect(await runCli(['user', 'create', 'a@example.com', '--generate-password', '--password-stdin'], io)).toBe(2)
    expect(lines.join('\n')).toContain('either --password-stdin or --generate-password')
  })

  it('prints a client configuration for the mcp command', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    const { lines, io } = capture()

    const code = await runCli(
      ['mcp', '--print-config', 'opencode', '--config', join(directory, 'mungil.config.ts')],
      io,
    )
    expect(code).toBe(0)

    const document = JSON.parse(lines.join('\n')) as {
      mcp: { servers: { mungilbase: { type: string; command: string[]; cwd: string } } }
    }
    const entry = document.mcp.servers.mungilbase
    expect(entry.type).toBe('local')
    expect(entry.command).not.toContain('npx')
    expect(entry.command).toEqual(expect.arrayContaining(['mcp', '--user', 'demo@example.com']))
    expect(entry.cwd).toBe(directory)
  })

  it('rejects an unknown --print-config client', async () => {
    const { lines, io } = capture()
    expect(await runCli(['mcp', '--print-config', 'nope'], io)).toBe(2)
    expect(lines.join('\n')).toContain('unknown client')
  })

  it('treats a config path as the start argument', async () => {
    // Reaching `start` is enough here; it fails on a missing file before it
    // can open a listener.
    const { lines, io } = capture()
    expect(await runCli(['./does-not-exist.json'], io)).toBe(1)
    expect(lines.join('\n')).toContain('Config file not found')
  })
})
