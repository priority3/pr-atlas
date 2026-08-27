import {
  hashText,
  stableId,
  type ConnectorContext,
  type ConnectorManifest,
  type ConnectorResult,
  type JsonValue,
  type AtlasConnector,
  type PrivacyLevel,
} from '@pr-atlas/schema'
import { describeNetworkFailure } from '../shared/http.js'

const REQUEST_TIMEOUT_MS = 20_000

export interface GenericWebConfig {
  url: string
  title?: string
  note?: string
  tags?: string[]
  privacy_level?: PrivacyLevel
  allow_cloud_llm?: boolean
}

const manifest: ConnectorManifest = {
  id: 'generic-web',
  version: '1.0.0',
  name: 'Generic Web',
  description: 'Capture a public web page as a single reference or text document.',
  capabilities: ['manual', 'batch'],
  permissions: ['network'],
  default_schedule: null,
  config_schema: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      note: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      privacy_level: { type: 'string', enum: ['public', 'private', 'sensitive'], default: 'private' },
      allow_cloud_llm: { type: 'boolean', default: false },
    },
  },
}

export function createGenericWebConnector(): AtlasConnector {
  return {
    manifest: () => manifest,
    async collect(context: ConnectorContext): Promise<ConnectorResult> {
      const config = parseConfig(context.instance.config)
      const url = config.url
      let response: Response
      try {
        response = await fetch(url, {
          headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        throw describeNetworkFailure(error, url, REQUEST_TIMEOUT_MS, new URL(url).host)
      }
      if (!response.ok) throw new Error(`Web capture failed: HTTP ${response.status} ${url}`)

      const html = await response.text()
      const title = config.title ?? extractTitle(html) ?? url
      const text = extractText(html)
      const contentHash = hashText(html)
      const uri = canonicalUrl(url)
      const captureId = stableId(
        'cap',
        JSON.stringify({ connector: manifest.id, instance: context.instance.id, uri, contentHash }),
      )

      return {
        captures: [
          {
            schema_version: 'atlas.capture.v1',
            id: captureId,
            connector: manifest.id,
            instance_id: context.instance.id,
            run_id: context.run_id,
            observed_at: context.now,
            captured_at: context.now,
            subject: {
              kind: 'web',
              uri,
              title,
              url,
            },
            payload: {
              kind: text ? 'text' : 'reference',
              text: text || null,
              raw_ref: null,
              content_hash: contentHash,
              mime_type: response.headers.get('content-type'),
            },
            note: config.note ?? null,
            tags: config.tags ?? [],
            metadata: {
              status: response.status,
              content_length: html.length,
            } satisfies Record<string, JsonValue>,
            privacy: {
              level: config.privacy_level ?? 'private',
              allow_cloud_llm: config.allow_cloud_llm ?? false,
            },
            provenance: {
              trigger: context.trigger,
              connector_version: `${manifest.id}@${manifest.version}`,
              cursor: null,
            },
          },
        ],
        checkpoint: null,
      }
    },
  }
}

/**
 * Narrows loosely-typed instance config into `GenericWebConfig`.
 *
 * Mirrors the field-by-field style used by `priority-me-blog`: the manifest
 * schema is validated by the runtime before `collect` runs, but a connector
 * must not depend on that to stay type-honest about its own input.
 */
function parseConfig(value: Record<string, JsonValue>): GenericWebConfig {
  const url = value.url
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    throw new Error('generic-web requires an http(s) config.url')
  }

  const config: GenericWebConfig = { url: url.trim() }
  const title = value.title
  const note = value.note
  const tags = value.tags
  const privacyLevel = value.privacy_level
  const allowCloudLlm = value.allow_cloud_llm

  if (typeof title === 'string' && title.trim()) config.title = title.trim()
  if (typeof note === 'string' && note.trim()) config.note = note.trim()
  if (Array.isArray(tags)) {
    config.tags = [
      ...new Set(
        tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map(tag => tag.trim())
          .filter(Boolean),
      ),
    ]
  }
  if (privacyLevel === 'public' || privacyLevel === 'private' || privacyLevel === 'sensitive') {
    config.privacy_level = privacyLevel
  }
  if (typeof allowCloudLlm === 'boolean') config.allow_cloud_llm = allowCloudLlm
  return config
}

function canonicalUrl(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.toString()
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match?.[1]) return null
  return decodeEntities(stripTags(match[1])).replace(/\s+/g, ' ').trim() || null
}

function extractText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  return decodeEntities(stripTags(withoutNoise)).replace(/\s+/g, ' ').trim()
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}
