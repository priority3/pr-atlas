import {
  hashText,
  stableId,
  type ConnectorContext,
  type ConnectorManifest,
  type ConnectorResult,
  type JsonValue,
  type LoreCapture,
  type LoreConnector,
  type PrivacyLevel,
} from '@pr-lore/schema'
import { mapWithConcurrency } from '../shared/pool.js'
import { parseFrontmatter } from './frontmatter.js'
import {
  GitHubClient,
  encodePath,
  githubBlobUrl,
  githubHeaders,
  parseGitHubRepository,
  type GitHubRepository,
  type GitHubTreeEntry,
} from './github.js'

const DEFAULT_CONTENT_DIR = 'src/content/blogs'

// Reason: GitHub bills one request per blob. Four at a time keeps a large blog
// responsive without burning through the rate limit in a burst.
const BLOB_CONCURRENCY = 4

export interface PriorityMeBlogConfig {
  repository_url: string
  branch?: string
  content_dir?: string
  site_url?: string
  source_name?: string
  /** Name of an environment variable containing a GitHub token. */
  token_env?: string
  privacy_level?: PrivacyLevel
  allow_cloud_llm?: boolean
}

/** Per-file state carried between runs so unchanged blobs are never refetched. */
interface Checkpoint {
  treeSha: string | null
  files: Record<string, string>
}

const manifest: ConnectorManifest = {
  id: 'priority-me-blog',
  version: '1.0.0',
  name: 'priority.me Blog',
  description: 'Collect Blog Markdown entries from a priority.me-style GitHub repository.',
  capabilities: ['manual', 'scheduled', 'incremental', 'batch'],
  permissions: ['network'],
  default_schedule: '0 3 * * *',
  config_schema: {
    type: 'object',
    required: ['repository_url'],
    additionalProperties: false,
    properties: {
      repository_url: {
        type: 'string',
        format: 'uri',
        description: 'GitHub repository URL, for example https://github.com/owner/repo.',
      },
      branch: { type: 'string', description: 'Branch or tag; defaults to the repository default branch.' },
      content_dir: {
        type: 'string',
        default: DEFAULT_CONTENT_DIR,
        description: 'Blog-only Markdown directory relative to the repository root.',
      },
      site_url: { type: 'string', format: 'uri', description: 'Published Blog site URL.' },
      source_name: { type: 'string', default: 'priority.me' },
      token_env: {
        type: 'string',
        description: 'Optional environment variable name for a private-repository token.',
      },
      privacy_level: { type: 'string', enum: ['public', 'private', 'sensitive'], default: 'private' },
      allow_cloud_llm: { type: 'boolean', default: false },
    },
  },
}

export function createPriorityMeBlogConnector(): LoreConnector {
  return {
    manifest: () => manifest,
    async collect(context: ConnectorContext): Promise<ConnectorResult> {
      const config = parseConfig(context.instance.config)
      const repository = parseGitHubRepository(config.repository_url)
      const client = new GitHubClient(githubHeaders(config.token_env))

      // Reason: resolving the default branch costs a request, so it is only
      // fetched when neither the config nor the URL names a ref.
      const ref =
        cleanString(config.branch) ??
        repository.branchFromUrl ??
        (await client.defaultBranch(repository))
      if (!ref) throw new Error('GitHub repository does not expose a default branch; set config.branch')

      const contentDir = normalizeContentDir(
        cleanString(config.content_dir) ?? repository.contentDirFromUrl ?? DEFAULT_CONTENT_DIR,
      )

      const tree = await client.tree(repository, ref)
      if (tree.truncated) {
        throw new Error('GitHub repository tree is truncated; narrow config.content_dir before collecting')
      }

      const files = (tree.tree ?? [])
        .filter(entry => entry.type === 'blob' && isMarkdown(entry.path))
        .filter(entry => isWithinDirectory(entry.path, contentDir))
        .sort((a, b) => a.path.localeCompare(b.path))

      const treeSha = tree.sha ?? null
      const previous = readCheckpoint(context.instance.checkpoint, ref, contentDir)
      const checkpoint = buildCheckpoint(repository, ref, treeSha, contentDir, files, context.now)

      // Fast path: an identical tree SHA means nothing under the repository
      // changed, so every blob request can be skipped.
      if (previous?.treeSha && treeSha && previous.treeSha === treeSha) {
        return { captures: [], checkpoint: { ...checkpoint, changed: 0 } }
      }

      const changed = previous
        ? files.filter(file => previous.files[file.path] !== file.sha)
        : files

      const captures = await mapWithConcurrency(changed, BLOB_CONCURRENCY, async file => {
        const raw = await client.blobText(file.url)
        return toCapture({ context, config, repository, ref, contentDir, file, raw })
      })

      return { captures, checkpoint: { ...checkpoint, changed: changed.length } }
    },
  }
}

interface CaptureInput {
  context: ConnectorContext
  config: PriorityMeBlogConfig
  repository: GitHubRepository
  ref: string
  contentDir: string
  file: GitHubTreeEntry
  raw: string
}

function toCapture(input: CaptureInput): LoreCapture {
  const { context, config, repository, ref, contentDir, file, raw } = input
  const parsed = parseFrontmatter(raw)
  const slug = slugifyPath(file.path.slice(contentDir.length + 1).replace(/\.(md|mdoc)$/i, ''))
  const blobUrl = githubBlobUrl(repository, ref, file.path)
  const uri = `github://${repository.owner}/${repository.repo}/${file.path}?ref=${encodeURIComponent(ref)}`
  const contentHash = hashText(raw)
  const siteUrl = trimTrailingSlash(config.site_url)
  const articleUrl = siteUrl ? `${siteUrl}/posts/${encodePath(slug)}` : null

  return {
    schema_version: 'lore.capture.v1',
    id: stableId(
      'cap',
      JSON.stringify({ connector: manifest.id, instance: context.instance.id, uri, contentHash }),
    ),
    connector: manifest.id,
    instance_id: context.instance.id,
    run_id: context.run_id,
    observed_at: context.now,
    captured_at: context.now,
    subject: {
      kind: 'document',
      uri,
      title: stringValue(parsed.data.title) ?? slug,
      url: articleUrl ?? blobUrl,
    },
    payload: {
      kind: 'markdown',
      text: parsed.body,
      raw_ref: blobUrl,
      content_hash: contentHash,
      mime_type: 'text/markdown',
    },
    note: null,
    tags: collectTags(parsed.data),
    metadata: {
      collection: 'blogs',
      path: file.path,
      source_name: cleanString(config.source_name) ?? 'priority.me',
      repository: repositoryUrl(repository),
      ref,
      blob_sha: file.sha,
      source_url: blobUrl,
      frontmatter: parsed.data,
    },
    privacy: {
      level: config.privacy_level ?? 'private',
      allow_cloud_llm: config.allow_cloud_llm ?? false,
    },
    provenance: {
      trigger: context.trigger,
      connector_version: `${manifest.id}@${manifest.version}`,
      cursor: file.sha,
    },
  }
}

function buildCheckpoint(
  repository: GitHubRepository,
  ref: string,
  treeSha: string | null,
  contentDir: string,
  files: GitHubTreeEntry[],
  now: string,
): Record<string, JsonValue> {
  return {
    scanned_at: now,
    repository: repositoryUrl(repository),
    ref,
    tree_sha: treeSha,
    content_dir: contentDir,
    file_count: files.length,
    files: Object.fromEntries(files.map(file => [file.path, file.sha])),
  }
}

/**
 * Reads prior per-file state, returning null whenever a full scan is required.
 *
 * A checkpoint from a different ref or content directory describes a different
 * set of files, and builds before per-file tracking stored `files` as a count,
 * which carries no usable state.
 */
function readCheckpoint(
  value: Record<string, JsonValue> | null,
  ref: string,
  contentDir: string,
): Checkpoint | null {
  if (!value) return null
  if (value.ref !== ref || value.content_dir !== contentDir) return null

  const files = value.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null

  const tracked: Record<string, string> = {}
  for (const [path, sha] of Object.entries(files)) {
    if (typeof sha === 'string') tracked[path] = sha
  }

  return {
    treeSha: typeof value.tree_sha === 'string' ? value.tree_sha : null,
    files: tracked,
  }
}

function parseConfig(value: Record<string, JsonValue>): PriorityMeBlogConfig {
  const repositoryUrlValue = value.repository_url
  if (typeof repositoryUrlValue !== 'string' || !repositoryUrlValue.trim()) {
    throw new Error('priority-me-blog requires config.repository_url')
  }

  const config: PriorityMeBlogConfig = { repository_url: repositoryUrlValue.trim() }
  const branch = value.branch
  const contentDir = value.content_dir
  const siteUrl = value.site_url
  const sourceName = value.source_name
  const tokenEnv = value.token_env
  const privacyLevel = value.privacy_level
  const allowCloudLlm = value.allow_cloud_llm
  if (typeof branch === 'string' && branch.trim()) config.branch = branch.trim()
  if (typeof contentDir === 'string' && contentDir.trim()) config.content_dir = contentDir.trim()
  if (typeof siteUrl === 'string' && siteUrl.trim()) config.site_url = siteUrl.trim()
  if (typeof sourceName === 'string' && sourceName.trim()) config.source_name = sourceName.trim()
  if (typeof tokenEnv === 'string' && tokenEnv.trim()) config.token_env = tokenEnv.trim()
  if (privacyLevel === 'public' || privacyLevel === 'private' || privacyLevel === 'sensitive') {
    config.privacy_level = privacyLevel
  }
  if (typeof allowCloudLlm === 'boolean') config.allow_cloud_llm = allowCloudLlm
  return config
}

function repositoryUrl(repository: GitHubRepository): string {
  return `https://github.com/${repository.owner}/${repository.repo}`
}

function normalizeContentDir(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.split('/').some(part => part === '..')) {
    throw new Error('priority-me-blog content_dir must be a repository-relative directory')
  }
  return normalized
}

function isWithinDirectory(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`)
}

function isMarkdown(file: string): boolean {
  return /\.(md|mdoc)$/i.test(file)
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function collectTags(data: Record<string, JsonValue>): string[] {
  const values: string[] = []
  for (const candidate of [data.tag, data.tags]) {
    if (typeof candidate === 'string') values.push(candidate)
    else if (Array.isArray(candidate)) {
      values.push(...candidate.filter((item): item is string => typeof item === 'string'))
    }
  }
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function slugify(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._~-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function slugifyPath(value: string): string {
  return value
    .split('/')
    .map(segment => slugify(segment))
    .filter(Boolean)
    .join('/')
}

function cleanString(value: string | undefined): string | null {
  return value?.trim() || null
}

function trimTrailingSlash(value: string | undefined): string | null {
  if (!value?.trim()) return null
  return value.trim().replace(/\/+$/, '')
}
