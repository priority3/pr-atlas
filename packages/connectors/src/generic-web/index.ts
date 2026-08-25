import {
  hashText,
  stableId,
  type ConnectorContext,
  type ConnectorManifest,
  type ConnectorResult,
  type JsonValue,
  type LoreConnector,
  type PrivacyLevel,
} from '@pr-lore/schema'

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

export function createGenericWebConnector(): LoreConnector {
  return {
    manifest: () => manifest,
    async collect(context: ConnectorContext): Promise<ConnectorResult> {
      const config = context.instance.config as unknown as GenericWebConfig
      const url = requireUrl(config.url)
      const response = await fetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`Web capture failed: HTTP ${response.status}`)

      const html = await response.text()
      const title = config.title?.trim() || extractTitle(html) || url
      const text = extractText(html)
      const contentHash = hashText(html)
      const uri = canonicalUrl(url)
      const privacyLevel = normalizePrivacyLevel(config.privacy_level)
      const captureId = stableId(
        'cap',
        JSON.stringify({ connector: manifest.id, instance: context.instance.id, uri, contentHash }),
      )

      return {
        captures: [
          {
            schema_version: 'lore.capture.v1',
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
            note: config.note?.trim() || null,
            tags: [...new Set((config.tags ?? []).map(tag => tag.trim()).filter(Boolean))],
            metadata: {
              status: response.status,
              content_length: html.length,
            } satisfies Record<string, JsonValue>,
            privacy: {
              level: privacyLevel,
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

function normalizePrivacyLevel(value: PrivacyLevel | undefined): PrivacyLevel {
  return value === 'public' || value === 'sensitive' ? value : 'private'
}

function requireUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw new Error('generic-web requires an http(s) URL')
  }
  return value
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
