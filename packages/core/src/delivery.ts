import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { JsonValue, LoreCapture, PrivacyLevel } from '@pr-lore/schema'
import type { OutboxStore } from './outbox.js'

/**
 * A delivery target for outbox entries.
 *
 * `deliver` throwing is the failure signal. `accepts` is separate because a
 * capture a target is not allowed to receive is neither a success nor a
 * failure — it should stay pending, not burn retry attempts.
 */
export interface Deliverer {
  readonly id: string
  readonly kind: string
  /** Returns a reason to skip this capture, or null to deliver it. */
  accepts?(capture: LoreCapture): string | null
  deliver(capture: LoreCapture): Promise<void>
}

const ALL_PRIVACY_LEVELS: PrivacyLevel[] = ['public', 'private', 'sensitive']

// Reason: matches the fail-closed default used throughout the capture pipeline.
// Anything leaving the machine excludes `sensitive` unless explicitly opted in.
const NETWORK_PRIVACY_LEVELS: PrivacyLevel[] = ['public', 'private']

export interface FileDelivererConfig {
  directory: string
  include_privacy_levels?: PrivacyLevel[]
}

export interface WebhookDelivererConfig {
  url: string
  token_env?: string
  headers?: Record<string, string>
  include_privacy_levels?: PrivacyLevel[]
  timeout_ms?: number
}

export function createFileDeliverer(config: FileDelivererConfig, id = 'file'): Deliverer {
  const directory = resolve(config.directory)
  const gate = privacyGate(config.include_privacy_levels ?? ALL_PRIVACY_LEVELS)
  return {
    id,
    kind: 'file',
    accepts: gate,
    async deliver(capture: LoreCapture): Promise<void> {
      await mkdir(directory, { recursive: true })
      const target = join(directory, `${capture.id}.json`)
      const temporary = `${target}.tmp`
      await writeFile(temporary, `${JSON.stringify(capture, null, 2)}\n`, 'utf8')
      await rename(temporary, target)
    },
  }
}

export function createWebhookDeliverer(config: WebhookDelivererConfig, id = 'webhook'): Deliverer {
  const gate = privacyGate(config.include_privacy_levels ?? NETWORK_PRIVACY_LEVELS)
  return {
    id,
    kind: 'webhook',
    accepts: gate,
    async deliver(capture: LoreCapture): Promise<void> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'pr-lore/0.2.0',
        ...config.headers,
      }
      if (config.token_env) {
        const token = process.env[config.token_env]?.trim()
        if (!token) throw new Error(`Environment variable ${config.token_env} is not set`)
        headers.authorization = `Bearer ${token}`
      }

      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(capture),
        signal: AbortSignal.timeout(config.timeout_ms ?? 20_000),
      })
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim().slice(0, 200)
        throw new Error(`Webhook responded HTTP ${response.status}${body ? `: ${body}` : ''}`)
      }
    },
  }
}

export const DELIVERER_KINDS = ['file', 'webhook'] as const
export type DelivererKind = (typeof DELIVERER_KINDS)[number]

const PRIVACY_LEVELS_SCHEMA: JsonValue = {
  type: 'array',
  items: { type: 'string', enum: ['public', 'private', 'sensitive'] },
  description: 'Privacy levels this target is allowed to receive.',
}

export const DELIVERER_SCHEMAS: Record<DelivererKind, JsonValue> = {
  file: {
    type: 'object',
    required: ['directory'],
    additionalProperties: false,
    properties: {
      directory: { type: 'string', minLength: 1, description: 'Destination directory for exported captures.' },
      include_privacy_levels: PRIVACY_LEVELS_SCHEMA,
    },
  },
  webhook: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri', description: 'Endpoint receiving one capture per POST.' },
      token_env: { type: 'string', description: 'Environment variable name holding a bearer token.' },
      headers: { type: 'object', description: 'Additional request headers.' },
      include_privacy_levels: PRIVACY_LEVELS_SCHEMA,
      timeout_ms: { type: 'integer', description: 'Request timeout in milliseconds (default 20000).' },
    },
  },
}

export function isDelivererKind(value: string): value is DelivererKind {
  return (DELIVERER_KINDS as readonly string[]).includes(value)
}

export function createDeliverer(
  kind: DelivererKind,
  config: Record<string, JsonValue>,
  id: string,
): Deliverer {
  return kind === 'file'
    ? createFileDeliverer(parseFileConfig(config), id)
    : createWebhookDeliverer(parseWebhookConfig(config), id)
}

export interface SyncOptions {
  /** Stop after this many delivery attempts. Skipped entries do not count. */
  limit?: number
  ids?: string[]
}

export interface SyncFailure {
  id: string
  error: string
}

export interface SyncSkip {
  id: string
  reason: string
}

export interface SyncSummary {
  target: string
  attempted: number
  delivered: string[]
  failed: SyncFailure[]
  skipped: SyncSkip[]
}

/**
 * Delivers pending outbox entries one at a time.
 *
 * Sequential on purpose: webhook receivers are far more likely to rate-limit
 * than to be a throughput bottleneck here, and ordering stays predictable.
 */
export async function syncOutbox(
  outbox: OutboxStore,
  deliverer: Deliverer,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const wanted = options.ids && options.ids.length > 0 ? new Set(options.ids) : null
  const pending = (await outbox.list('pending')).filter(
    entry => !wanted || wanted.has(entry.capture.id),
  )

  const summary: SyncSummary = {
    target: deliverer.id,
    attempted: 0,
    delivered: [],
    failed: [],
    skipped: [],
  }

  for (const entry of pending) {
    if (options.limit !== undefined && summary.attempted >= options.limit) break

    const capture = entry.capture
    const reason = deliverer.accepts?.(capture) ?? null
    if (reason) {
      summary.skipped.push({ id: capture.id, reason })
      continue
    }

    summary.attempted += 1
    try {
      await deliverer.deliver(capture)
      await outbox.mark(capture.id, 'sent')
      summary.delivered.push(capture.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await outbox.mark(capture.id, 'failed', message)
      summary.failed.push({ id: capture.id, error: message })
    }
  }

  return summary
}

function privacyGate(levels: PrivacyLevel[]): (capture: LoreCapture) => string | null {
  return capture =>
    levels.includes(capture.privacy.level)
      ? null
      : `privacy level "${capture.privacy.level}" is not accepted by this target`
}

function parseFileConfig(value: Record<string, JsonValue>): FileDelivererConfig {
  const directory = value.directory
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new Error('file target requires config.directory')
  }
  const config: FileDelivererConfig = { directory: directory.trim() }
  const levels = parsePrivacyLevels(value.include_privacy_levels)
  if (levels) config.include_privacy_levels = levels
  return config
}

function parseWebhookConfig(value: Record<string, JsonValue>): WebhookDelivererConfig {
  const url = value.url
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('webhook target requires an http(s) config.url')
  }

  const config: WebhookDelivererConfig = { url: url.trim() }
  const tokenEnv = value.token_env
  const timeout = value.timeout_ms
  if (typeof tokenEnv === 'string' && tokenEnv.trim()) config.token_env = tokenEnv.trim()
  if (typeof timeout === 'number' && Number.isFinite(timeout)) config.timeout_ms = timeout

  const headers = value.headers
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const parsed: Record<string, string> = {}
    for (const [key, item] of Object.entries(headers)) {
      if (typeof item === 'string') parsed[key] = item
    }
    config.headers = parsed
  }

  const levels = parsePrivacyLevels(value.include_privacy_levels)
  if (levels) config.include_privacy_levels = levels
  return config
}

function parsePrivacyLevels(value: JsonValue | undefined): PrivacyLevel[] | null {
  if (!Array.isArray(value)) return null
  const levels = value.filter((item): item is PrivacyLevel =>
    typeof item === 'string' && (ALL_PRIVACY_LEVELS as string[]).includes(item),
  )
  return levels.length > 0 ? levels : null
}
