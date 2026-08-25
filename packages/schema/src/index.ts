import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type PrivacyLevel = 'public' | 'private' | 'sensitive'

export type CaptureTrigger = 'manual' | 'schedule' | 'webhook' | 'import'

export type SubjectKind =
  | 'url'
  | 'web'
  | 'repo'
  | 'feed'
  | 'file'
  | 'folder'
  | 'media'
  | 'text'
  | 'document'
  | `custom:${string}`

export type PayloadKind =
  | 'reference'
  | 'text'
  | 'markdown'
  | 'html'
  | 'json'
  | 'binary'

export interface LoreCapture {
  schema_version: 'lore.capture.v1'
  id: string
  connector: string
  instance_id: string | null
  run_id: string | null
  observed_at: string
  captured_at: string
  subject: {
    kind: SubjectKind
    uri: string
    title: string | null
    url: string | null
  }
  payload: {
    kind: PayloadKind
    text: string | null
    raw_ref: string | null
    content_hash: string | null
    mime_type: string | null
  }
  note: string | null
  tags: string[]
  metadata: Record<string, JsonValue>
  privacy: {
    level: PrivacyLevel
    allow_cloud_llm: boolean
  }
  provenance: {
    trigger: CaptureTrigger
    connector_version: string
    cursor: string | null
  }
}

export interface ConnectorManifest {
  id: string
  version: string
  name: string
  description: string
  capabilities: Array<'manual' | 'scheduled' | 'incremental' | 'batch'>
  permissions: Array<'network' | 'filesystem' | 'clipboard' | 'screen'>
  default_schedule: string | null
  config_schema: JsonValue
}

export interface ConnectorInstance {
  id: string
  connector: string
  enabled: boolean
  schedule: string | null
  config: Record<string, JsonValue>
  checkpoint: Record<string, JsonValue> | null
}

export interface ConnectorContext {
  instance: ConnectorInstance
  run_id: string
  trigger: CaptureTrigger
  now: string
}

export interface ConnectorResult {
  captures: LoreCapture[]
  checkpoint: Record<string, JsonValue> | null
}

export interface LoreConnector {
  manifest(): ConnectorManifest
  collect(context: ConnectorContext): Promise<ConnectorResult>
}

export function stableId(prefix: string, seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 20)
  return `${prefix}_${digest}`
}

export function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

export function assertValidCapture(value: unknown): LoreCapture {
  if (!value || typeof value !== 'object') throw new Error('Capture must be an object')
  const capture = value as Partial<LoreCapture>
  if (capture.schema_version !== 'lore.capture.v1') {
    throw new Error('Unsupported capture schema')
  }
  if (
    typeof capture.id !== 'string' ||
    !capture.id ||
    typeof capture.connector !== 'string' ||
    !capture.connector ||
    typeof capture.observed_at !== 'string' ||
    !capture.observed_at ||
    typeof capture.captured_at !== 'string' ||
    !capture.captured_at
  ) {
    throw new Error('Capture requires id, connector, observed_at, and captured_at')
  }
  if (!capture.subject || typeof capture.subject !== 'object' || !capture.subject.kind || typeof capture.subject.uri !== 'string' || !capture.subject.uri) {
    throw new Error('Capture requires subject.kind and subject.uri')
  }
  if (!capture.payload || typeof capture.payload !== 'object' || !capture.payload.kind) {
    throw new Error('Capture requires payload.kind')
  }
  if (!capture.privacy || typeof capture.privacy !== 'object' || !capture.privacy.level) {
    throw new Error('Capture requires privacy.level')
  }
  if (!['public', 'private', 'sensitive'].includes(capture.privacy.level)) {
    throw new Error('Capture privacy.level is invalid')
  }
  if (!Array.isArray(capture.tags) || !capture.tags.every(tag => typeof tag === 'string')) {
    throw new Error('Capture tags must be an array of strings')
  }
  if (!capture.metadata || typeof capture.metadata !== 'object' || Array.isArray(capture.metadata) || !isJsonValue(capture.metadata)) {
    throw new Error('Capture metadata must be an object')
  }
  return value as LoreCapture
}
