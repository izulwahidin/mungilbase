import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { LocalStorage } from '../../src/storage/local.js'
import { createStorage } from '../../src/storage/storage.js'
import { S3Storage, type S3ClientLike } from '../../src/storage/s3.js'

const storageConfig = configSchema.parse({
  storage: {
    provider: 's3',
    s3: { bucket: 'files', prefix: 'mungil' },
  },
}).storage!

const s3Config = storageConfig.s3!

const key = 'posts/0123456789abcdef/avatar/123e4567-e89b-12d3-a456-426614174000.png'

describe('S3Storage', () => {
  it('maps put/get/delete/list onto object commands', async () => {
    const commands: { name: string; input: Record<string, unknown> }[] = []
    const responses: unknown[] = [
      {},
      {
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
        ContentType: 'image/png',
        Metadata: { filename: Buffer.from('pic.png').toString('base64url') },
      },
      {},
      { Contents: [{ Key: `mungil/${key}` }], IsTruncated: false },
    ]

    const client: S3ClientLike = {
      async send(command) {
        commands.push({ name: command.constructor.name, input: command.input })
        return responses.shift()
      },
    }

    const storage = new S3Storage(s3Config, client)

    await storage.put(key, Buffer.from('abc'), 'image/png', 'pic.png')
    expect(commands[0]!.name).toBe('PutObjectCommand')
    expect(commands[0]!.input.Bucket).toBe('files')
    expect(commands[0]!.input.Key).toBe(`mungil/${key}`)
    expect((commands[0]!.input.Metadata as { filename: string }).filename).toBe(
      Buffer.from('pic.png').toString('base64url'),
    )

    const stored = await storage.get(key)
    expect(stored?.contentType).toBe('image/png')
    expect(stored?.filename).toBe('pic.png')
    expect([...(stored?.data ?? [])]).toEqual([1, 2, 3])

    await storage.delete(key)
    expect(commands[2]!.name).toBe('DeleteObjectCommand')

    expect(await storage.list()).toEqual([key])
  })

  it('paginates list results', async () => {
    const responses = [
      {
        Contents: [{ Key: 'p/a.png' }, { Key: 'p/b.png' }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      },
      { Contents: [{ Key: 'p/c.png' }], IsTruncated: false },
    ]
    const client: S3ClientLike = { send: async () => responses.shift() }

    const storage = new S3Storage({ ...s3Config, prefix: 'p' }, client)
    expect(await storage.list()).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('treats missing objects as null', async () => {
    const client: S3ClientLike = {
      send: async () => {
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
      },
    }
    expect(await new S3Storage(s3Config, client).get(key)).toBeNull()
  })

  it('fails at boot without credentials', () => {
    expect(() => new S3Storage(s3Config, undefined, {})).toThrow(/MUNGIL_S3_ACCESS_KEY_ID/)
  })

  it('selects local or S3 from config', () => {
    expect(createStorage(undefined)).toBeInstanceOf(LocalStorage)
    expect(
      createStorage(storageConfig, {
        MUNGIL_S3_ACCESS_KEY_ID: 'id',
        MUNGIL_S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toBeInstanceOf(S3Storage)
  })
})
