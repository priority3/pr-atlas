import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConnectorInstance, JsonValue } from '@pr-lore/schema'

export interface LoreConfigFile {
  version: 1
  instances: ConnectorInstance[]
}

export class ConfigStore {
  readonly file: string

  constructor(dataDirectory: string) {
    this.file = join(dataDirectory, 'config.json')
  }

  async load(): Promise<LoreConfigFile> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<LoreConfigFile>
      if (!Array.isArray(parsed.instances)) throw new Error('config.instances must be an array')
      return { version: 1, instances: parsed.instances as ConnectorInstance[] }
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, instances: [] }
      throw error
    }
  }

  async save(config: LoreConfigFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }

  async get(id: string): Promise<ConnectorInstance | null> {
    const config = await this.load()
    return config.instances.find(instance => instance.id === id) ?? null
  }

  async upsert(instance: ConnectorInstance): Promise<ConnectorInstance> {
    const config = await this.load()
    const index = config.instances.findIndex(item => item.id === instance.id)
    if (index < 0) config.instances.push(instance)
    else config.instances[index] = instance
    await this.save(config)
    return instance
  }

  async remove(id: string): Promise<boolean> {
    const config = await this.load()
    const next = config.instances.filter(instance => instance.id !== id)
    if (next.length === config.instances.length) return false
    await this.save({ ...config, instances: next })
    return true
  }
}

export function asJsonObject(value: string, label: string): Record<string, JsonValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, JsonValue>
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
