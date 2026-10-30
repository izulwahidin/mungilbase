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
  /** All keys currently stored, without the configured prefix. */
  list(): Promise<string[]>
}

export function createStorage(config: StorageConfig | undefined): Storage {
  return new LocalStorage(config?.local.dir ?? './data/files')
}
