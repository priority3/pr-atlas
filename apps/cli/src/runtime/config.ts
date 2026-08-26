import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DELIVERER_KINDS, isDelivererKind, type DelivererKind } from '@pr-lore/core'
import {
  assertConnectorInstance,
  isPlainObject,
  type ConnectorInstance,
  type JsonValue,
} from '@pr-lore/schema'

export interface DeliveryTarget {
  id: string
  kind: DelivererKind
  config: Record<string, JsonValue>
}

export interface LoreConfigFile {
  version: 1
  instances: ConnectorInstance[]
  targets: DeliveryTarget[]
}

export class ConfigStore {
  readonly file: string

  constructor(dataDirectory: string) {
    this.file = join(dataDirectory, 'config.json')
  }

  async load(): Promise<LoreConfigFile> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, instances: [], targets: [] }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`${this.file} is not valid JSON`)
    }
    if (!isPlainObject(parsed)) throw new Error(`${this.file} must contain an object`)

    const instances = parsed.instances ?? []
    if (!Array.isArray(instances)) throw new Error(`${this.file}: instances must be an array`)

    // Reason: `targets` was added after the first release, so its absence is
    // normal rather than a corrupt file.
    const targets = parsed.targets ?? []
    if (!Array.isArray(targets)) throw new Error(`${this.file}: targets must be an array`)

    return {
      version: 1,
      instances: instances.map(instance => assertConnectorInstance(instance, 'connector instance')),
      targets: targets.map(target => assertDeliveryTarget(target)),
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

  async getTarget(id: string): Promise<DeliveryTarget | null> {
    const config = await this.load()
    return config.targets.find(target => target.id === id) ?? null
  }

  async upsertTarget(target: DeliveryTarget): Promise<DeliveryTarget> {
    const config = await this.load()
    const index = config.targets.findIndex(item => item.id === target.id)
    if (index < 0) config.targets.push(target)
    else config.targets[index] = target
    await this.save(config)
    return target
  }

  async removeTarget(id: string): Promise<boolean> {
    const config = await this.load()
    const next = config.targets.filter(target => target.id !== id)
    if (next.length === config.targets.length) return false
    await this.save({ ...config, targets: next })
    return true
  }
}

export function assertDeliveryTarget(value: unknown): DeliveryTarget {
  if (!isPlainObject(value)) throw new Error('delivery target must be an object')

  const { id, kind, config } = value
  if (typeof id !== 'string' || !id.trim()) throw new Error('delivery target requires a non-empty id')
  if (typeof kind !== 'string' || !isDelivererKind(kind)) {
    throw new Error(
      `delivery target "${id}" has an unknown kind; supported kinds are ${DELIVERER_KINDS.join(', ')}`,
    )
  }
  if (config !== undefined && !isPlainObject(config)) {
    throw new Error(`delivery target "${id}" has a non-object config`)
  }

  return { id: id.trim(), kind, config: config ?? {} }
}

export function asJsonObject(value: string, label: string): Record<string, JsonValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`)
  return parsed
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
