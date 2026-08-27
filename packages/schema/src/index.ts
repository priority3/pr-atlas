import { createHash } from 'node:crypto'
import { isJsonValue, isPlainObject, type JsonValue } from './json.js'

export { isJsonValue, isPlainObject } from './json.js'
export type { JsonPrimitive, JsonValue } from './json.js'
export { validateJsonSchema } from './json-schema.js'

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

export interface AtlasCapture {
  schema_version: 'atlas.capture.v1'
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
  captures: AtlasCapture[]
  checkpoint: Record<string, JsonValue> | null
}

export interface AtlasConnector {
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

export function assertValidCapture(value: unknown): AtlasCapture {
  if (!value || typeof value !== 'object') throw new Error('Capture must be an object')
  const capture = value as Partial<AtlasCapture>
  if (capture.schema_version !== 'atlas.capture.v1') {
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
  return value as AtlasCapture
}

/**
 * Normalizes a persisted connector instance.
 *
 * Absent optional fields fall back to their defaults, but a field present with
 * the wrong type is an error: a hand-edited `config.json` should fail loudly
 * rather than silently run with a coerced value.
 */
export function assertConnectorInstance(value: unknown, label = 'connector instance'): ConnectorInstance {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)

  const { id, connector, enabled, schedule, config, checkpoint } = value
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${label} requires a non-empty id`)
  if (typeof connector !== 'string' || !connector.trim()) {
    throw new Error(`${label} "${id}" requires a connector id`)
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`${label} "${id}" has a non-boolean enabled`)
  }
  if (schedule !== undefined && schedule !== null && typeof schedule !== 'string') {
    throw new Error(`${label} "${id}" has a non-string schedule`)
  }
  if (config !== undefined && !isPlainObject(config)) {
    throw new Error(`${label} "${id}" has a non-object config`)
  }
  if (checkpoint !== undefined && checkpoint !== null && !isPlainObject(checkpoint)) {
    throw new Error(`${label} "${id}" has a non-object checkpoint`)
  }

  return {
    id: id.trim(),
    connector: connector.trim(),
    enabled: enabled ?? true,
    schedule: schedule ?? null,
    config: config ?? {},
    checkpoint: checkpoint ?? null,
  }
}
