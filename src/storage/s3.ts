import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { StorageConfig } from '../config/schema.js'
import type { Storage, StoredFile } from './storage.js'

export type S3Config = NonNullable<StorageConfig['s3']>

export interface S3ClientLike {
  // The SDK's command generics are not worth reproducing; tests provide a fake.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>
}

interface GetResult {
  Body?: { transformToByteArray(): Promise<Uint8Array> }
  ContentType?: string
  Metadata?: Record<string, string>
}

interface ListResult {
  Contents?: { Key?: string }[]
  IsTruncated?: boolean
  NextContinuationToken?: string
}

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze).
 *
 * Keys are stored under an optional prefix. Metadata carries the original
 * filename (base64url) because object keys are opaque.
 */
export class S3Storage implements Storage {
  private readonly client: S3ClientLike
  private readonly prefix: string

  constructor(
    private readonly config: S3Config,
    client?: S3ClientLike,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.prefix = config.prefix ? `${config.prefix.replace(/^\/+|\/+$/g, '')}/` : ''

    if (client) {
      this.client = client
      return
    }

    const accessKeyId = env[config.accessKeyIdEnv]
    const secretAccessKey = env[config.secretAccessKeyEnv]
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `Missing S3 credentials in ${config.accessKeyIdEnv} / ${config.secretAccessKeyEnv}`,
      )
    }

    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    })
  }

  async put(key: string, data: Buffer, contentType: string, filename: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(key),
        Body: data,
        ContentType: contentType,
        Metadata: { filename: Buffer.from(filename, 'utf8').toString('base64url') },
      }),
    )
  }

  async get(key: string): Promise<StoredFile | null> {
    try {
      const result = (await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }),
      )) as GetResult

      if (!result.Body) return null
      const bytes = await result.Body.transformToByteArray()

      return {
        data: Buffer.from(bytes),
        contentType: result.ContentType ?? 'application/octet-stream',
        filename: decodeFilename(result.Metadata?.filename),
      }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }),
    )
  }

  async list(): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined

    do {
      const result = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.prefix,
          ContinuationToken: token,
        }),
      )) as ListResult

      for (const item of result.Contents ?? []) {
        if (item.Key?.startsWith(this.prefix)) keys.push(item.Key.slice(this.prefix.length))
      }

      token = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (token)

    return keys
  }

  private key(key: string): string {
    return `${this.prefix}${key}`
  }
}

function decodeFilename(value: string | undefined): string {
  if (!value) return 'file'
  try {
    return Buffer.from(value, 'base64url').toString('utf8') || 'file'
  } catch {
    return 'file'
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404
}
