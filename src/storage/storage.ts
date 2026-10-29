import type { StorageConfig } from '../config/schema.js'
import { LocalStorage } from './local.js'

export interface StoredFile {
  data: Buffer
  contentType: string
  filename: string
}

export interface Storage {
  put(key: string, data: Buffer, contentType: string, filename: string): Promise<void>
  get(key: string): Promise<StoredFile | null>
  delete(key: string): Promise<void>
}

/**
 * Storage is behind an interface so an S3 adapter can be added without
 * touching the upload route. v0.1 ships local disk only.
 */
export function createStorage(config: StorageConfig | undefined): Storage {
  return new LocalStorage(config?.local.dir ?? './data/files')
}
