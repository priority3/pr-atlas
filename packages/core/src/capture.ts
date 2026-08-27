import {
  hashText,
  stableId,
  type CaptureTrigger,
  type JsonValue,
  type AtlasCapture,
  type PrivacyLevel,
  type SubjectKind,
} from '@pr-atlas/schema'

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

export function createManualCapture(input: ManualCaptureInput): AtlasCapture {
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
    schema_version: 'atlas.capture.v1',
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
