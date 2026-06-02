import { getUserDataPath } from '@root/shared/platform/paths'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { TStoreType } from '../../contracts/types/modules/store'

const DEFAULT_STORE: TStoreType = {
  last_projects: [],
  theme: 'light',
  window: {
    bounds: {
      width: 1440,
      height: 768,
      x: 0,
      y: 0,
    },
  },
}

class FileStore {
  private cache: TStoreType = { ...DEFAULT_STORE }
  private readonly storePath = join(getUserDataPath(), 'store.json')
  private loaded = false

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    await mkdir(dirname(this.storePath), { recursive: true })

    try {
      const content = await readFile(this.storePath, 'utf-8')
      this.cache = { ...DEFAULT_STORE, ...(JSON.parse(content) as TStoreType) }
    } catch {
      await writeFile(this.storePath, JSON.stringify(DEFAULT_STORE, null, 2), 'utf-8')
      this.cache = { ...DEFAULT_STORE }
    }

    this.loaded = true
  }

  async get<K extends keyof TStoreType>(key: K): Promise<TStoreType[K]> {
    await this.ensureLoaded()
    return this.cache[key]
  }

  async set<K extends keyof TStoreType>(key: K, value: TStoreType[K]): Promise<void> {
    await this.ensureLoaded()
    this.cache[key] = value
    await writeFile(this.storePath, JSON.stringify(this.cache, null, 2), 'utf-8')
  }

  getSync<K extends keyof TStoreType>(key: K): TStoreType[K] {
    return this.cache[key]
  }

  setSync<K extends keyof TStoreType>(key: K, value: TStoreType[K]): void {
    this.cache[key] = value
    void writeFile(this.storePath, JSON.stringify(this.cache, null, 2), 'utf-8')
  }
}

export const store = new FileStore()
