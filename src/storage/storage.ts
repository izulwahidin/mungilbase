import type { StorageConfig } from '../config/schema.js'
import { LocalStorage } from './local.js'
import { S3Storage } from './s3.js'

export interface StoredFile {
  data: Buffer
  contentType: string
  filename: string
}

export interface Storage {
  put(key: string, data: Buffer, contentType: string, filename: string): Promise<void>
  get(key: string): Promise<StoredFile | null>
  delete(key: string): Promise<void>
  /** All keys currently stored, without the configured prefix. */
  list(): Promise<string[]>
}

export function createStorage(
  config: StorageConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Storage {
  if (config?.provider === 's3') {
    if (!config.s3) throw new Error('storage.s3 is required for the s3 provider')
    return new S3Storage(config.s3, undefined, env)
  }

  return new LocalStorage(config?.local.dir ?? './data/files')
}
