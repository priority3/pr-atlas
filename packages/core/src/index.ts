import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertValidCapture,
  hashText,
  stableId,
  type CaptureTrigger,
  type ConnectorContext,
  type ConnectorInstance,
  type ConnectorResult,
  type JsonValue,
  type LoreCapture,
  type LoreConnector,
  type PrivacyLevel,
  type SubjectKind,
} from '@pr-lore/schema'

export class ConnectorRegistry {
  private readonly connectors = new Map<string, LoreConnector>()

  register(connector: LoreConnector): void {
    const id = connector.manifest().id
    if (this.connectors.has(id)) throw new Error(`Connector already registered: ${id}`)
    this.connectors.set(id, connector)
  }

  get(id: string): LoreConnector {
    const connector = this.connectors.get(id)
    if (!connector) throw new Error(`Unknown connector: ${id}`)
    return connector
  }

  list(): LoreConnector[] {
    return [...this.connectors.values()].sort((a, b) =>
      a.manifest().id.localeCompare(b.manifest().id),
    )
  }
}

export async function runConnector(
  registry: ConnectorRegistry,
  instance: ConnectorInstance,
  trigger: CaptureTrigger = 'manual',
): Promise<ConnectorResult> {
  const connector = registry.get(instance.connector)
  if (!instance.enabled && trigger !== 'manual') {
    throw new Error(`Connector instance is disabled: ${instance.id}`)
  }

  const context: ConnectorContext = {
    instance,
    run_id: `run_${randomUUID()}`,
    trigger,
    now: new Date().toISOString(),
  }
  const result = await connector.collect(context)
  for (const capture of result.captures) assertValidCapture(capture)
  return result
}

export interface ManualCaptureInput {
  uri: string
  text?: string | null
  title?: string | null
  note?: string | null
  tags?: string[]
  kind?: SubjectKind
  trigger?: CaptureTrigger
  now?: string
  metadata?: Record<string, JsonValue>
  privacy_level?: PrivacyLevel
  allow_cloud_llm?: boolean
}

export function createManualCapture(input: ManualCaptureInput): LoreCapture {
  const now = input.now ?? new Date().toISOString()
  const title = input.title?.trim() || null
  const note = input.note?.trim() || null
  const text = input.text?.trim() || null
  const tags = [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean))]
  const seed = JSON.stringify({
    uri: input.uri,
    note,
    text,
    title,
    tags,
    kind: input.kind ?? (text ? 'text' : 'url'),
  })

  return {
    schema_version: 'lore.capture.v1',
    id: stableId('cap', seed),
    connector: 'manual',
    instance_id: null,
    run_id: null,
    observed_at: now,
    captured_at: now,
    subject: {
      kind: input.kind ?? (text ? 'text' : 'url'),
      uri: input.uri,
      title,
      url: /^https?:\/\//i.test(input.uri) ? input.uri : null,
    },
    payload: {
      kind: text ? 'text' : 'reference',
      text,
      raw_ref: null,
      content_hash: hashText(text ?? input.uri),
      mime_type: null,
    },
    note,
    tags,
    metadata: input.metadata ?? {},
    privacy: {
      level: input.privacy_level ?? 'private',
      allow_cloud_llm: input.allow_cloud_llm ?? false,
    },
    provenance: {
      trigger: input.trigger ?? 'manual',
      connector_version: 'manual@1.0.0',
      cursor: null,
    },
  }
}

export interface OutboxEntry {
  capture: LoreCapture
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  last_error: string | null
  updated_at: string
}

export class OutboxStore {
  private readonly directory: string

  constructor(rootDirectory: string) {
    this.directory = join(rootDirectory, 'outbox')
  }

  async enqueue(capture: LoreCapture): Promise<OutboxEntry> {
    assertValidCapture(capture)
    await mkdir(this.directory, { recursive: true })
    const target = join(this.directory, `${capture.id}.json`)
    try {
      return JSON.parse(await readFile(target, 'utf8')) as OutboxEntry
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    const entry: OutboxEntry = {
      capture,
      status: 'pending',
      attempts: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    }
    await this.write(capture.id, entry)
    return entry
  }

  async list(status?: OutboxEntry['status']): Promise<OutboxEntry[]> {
    await mkdir(this.directory, { recursive: true })
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'))
    const entries: OutboxEntry[] = []
    for (const name of names.sort()) {
      const raw = await readFile(join(this.directory, name), 'utf8')
      const entry = JSON.parse(raw) as OutboxEntry
      if (!status || entry.status === status) entries.push(entry)
    }
    return entries
  }

  async mark(id: string, status: OutboxEntry['status'], error: string | null = null) {
    const file = join(this.directory, `${id}.json`)
    const current = JSON.parse(await readFile(file, 'utf8')) as OutboxEntry
    const entry: OutboxEntry = {
      ...current,
      status,
      attempts: current.attempts + (status === 'failed' ? 1 : 0),
      last_error: error,
      updated_at: new Date().toISOString(),
    }
    await this.write(id, entry)
    return entry
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.directory, `${id}.json`), { force: true })
  }

  async summary() {
    const entries = await this.list()
    return entries.reduce(
      (summary, entry) => {
        summary.total += 1
        summary[entry.status] += 1
        return summary
      },
      { total: 0, pending: 0, sent: 0, failed: 0 },
    )
  }

  private async write(id: string, entry: OutboxEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = join(this.directory, `${id}.json`)
    const temporary = `${target}.tmp`
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
