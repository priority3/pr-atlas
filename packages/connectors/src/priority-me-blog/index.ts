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

const DEFAULT_CONTENT_DIR = 'src/content/blogs'
const GITHUB_API = 'https://api.github.com'

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

interface GitHubRepository {
  owner: string
  repo: string
  branchFromUrl: string | null
  contentDirFromUrl: string | null
}

interface GitHubTreeEntry {
  path: string
  type: string
  sha: string
  url: string
}

interface GitHubTreeResponse {
  sha?: string
  truncated?: boolean
  tree?: GitHubTreeEntry[]
}

interface GitHubRepositoryResponse {
  default_branch?: string
}

interface GitHubBlobResponse {
  content?: string
  encoding?: string
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
      const headers = githubHeaders(config.token_env)
      const repositoryInfo = await fetchJson<GitHubRepositoryResponse>(
        `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
        headers,
      )
      const ref = cleanString(config.branch) ?? repository.branchFromUrl ?? repositoryInfo.default_branch
      if (!ref) throw new Error('GitHub repository does not expose a default branch; set config.branch')

      const contentDir = normalizeContentDir(
        cleanString(config.content_dir) ?? repository.contentDirFromUrl ?? DEFAULT_CONTENT_DIR,
      )
      const tree = await fetchJson<GitHubTreeResponse>(
        `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        headers,
      )
      if (tree.truncated) {
        throw new Error('GitHub repository tree is truncated; narrow config.content_dir before collecting')
      }

      const files = (tree.tree ?? [])
        .filter(entry => entry.type === 'blob' && isMarkdown(entry.path))
        .filter(entry => isWithinDirectory(entry.path, contentDir))
        .sort((a, b) => a.path.localeCompare(b.path))
      const captures = []

      for (const file of files) {
        const raw = await fetchGitHubBlob(file.url, headers)
        const parsed = parseFrontmatter(raw)
        const slug = slugifyPath(file.path.slice(contentDir.length + 1).replace(/\.(md|mdoc)$/i, ''))
        const sourceName = cleanString(config.source_name) ?? 'priority.me'
        const blobUrl = githubBlobUrl(repository, ref, file.path)
        const uri = `github://${repository.owner}/${repository.repo}/${file.path}?ref=${encodeURIComponent(ref)}`
        const contentHash = hashText(raw)
        const title = stringValue(parsed.data.title) || slug
        const siteUrl = trimTrailingSlash(config.site_url)
        const articleUrl = siteUrl ? `${siteUrl}/posts/${encodePath(slug)}` : null

        captures.push({
          schema_version: 'lore.capture.v1' as const,
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
            kind: 'document' as const,
            uri,
            title,
            url: articleUrl ?? blobUrl,
          },
          payload: {
            kind: 'markdown' as const,
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
            source_name: sourceName,
            repository: `https://github.com/${repository.owner}/${repository.repo}`,
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
        })
      }

      return {
        captures,
        checkpoint: {
          scanned_at: context.now,
          repository: `https://github.com/${repository.owner}/${repository.repo}`,
          ref,
          tree_sha: tree.sha ?? null,
          content_dir: contentDir,
          files: files.length,
        },
      }
    },
  }
}

function parseConfig(value: Record<string, JsonValue>): PriorityMeBlogConfig {
  const repositoryUrl = value.repository_url
  if (typeof repositoryUrl !== 'string' || !repositoryUrl.trim()) {
    throw new Error('priority-me-blog requires config.repository_url')
  }

  const config: PriorityMeBlogConfig = { repository_url: repositoryUrl.trim() }
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

function parseGitHubRepository(value: string): GitHubRepository {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('priority-me-blog repository_url must be a valid GitHub URL')
  }
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname)) {
    throw new Error('priority-me-blog repository_url must point to github.com')
  }

  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map(part => decodeURIComponent(part))
  if (parts.length < 2) throw new Error('GitHub repository_url must include owner and repository')
  const owner = parts[0]
  const repo = parts[1]?.replace(/\.git$/i, '')
  if (!owner || !repo) throw new Error('GitHub repository_url must include owner and repository')
  if (parts[2] && parts[2] !== 'tree') {
    throw new Error('GitHub repository_url must point to a repository or tree URL')
  }

  let branchFromUrl: string | null = null
  let contentDirFromUrl: string | null = null
  if (parts[2] === 'tree' && parts[3]) {
    branchFromUrl = parts[3]
    const path = parts.slice(4).join('/')
    contentDirFromUrl = path || null
  }
  return { owner, repo, branchFromUrl, contentDirFromUrl }
}

function githubHeaders(tokenEnv: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pr-lore/0.1.0',
  }
  const token = tokenEnv ? process.env[tokenEnv]?.trim() : undefined
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub request failed: HTTP ${response.status} ${url}`)
  }
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`GitHub request returned invalid JSON: ${url}`)
  }
}

async function fetchGitHubBlob(url: string, headers: Record<string, string>): Promise<string> {
  const body = await fetchJson<GitHubBlobResponse>(url, headers)
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`GitHub blob response is not base64: ${url}`)
  }
  return Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8')
}

function githubBlobUrl(repository: GitHubRepository, ref: string, path: string): string {
  return `https://github.com/${repository.owner}/${repository.repo}/blob/${encodePath(ref)}/${encodePath(path)}`
}

function encodePath(value: string): string {
  return value.split('/').map(segment => encodeURIComponent(segment)).join('/')
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

function parseFrontmatter(raw: string): {
  data: Record<string, JsonValue>
  body: string
} {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: raw.trim() }

  const data: Record<string, JsonValue> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!key) continue
    data[key] = parseScalar(value)
  }
  return { data, body: (match[2] ?? '').trim() }
}

function parseScalar(value: string): JsonValue {
  if (!value) return null
  const unquoted = value.replace(/^("|')([\s\S]*)\1$/, '$2')
  if (unquoted === 'true') return true
  if (unquoted === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted)
  if (unquoted.startsWith('[') && unquoted.endsWith(']')) {
    return unquoted
      .slice(1, -1)
      .split(',')
      .map(item => item.trim().replace(/^("|')([\s\S]*)\1$/, '$2'))
      .filter(Boolean)
  }
  return unquoted
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function collectTags(data: Record<string, JsonValue>): string[] {
  const values: string[] = []
  const tag = data.tag
  const tags = data.tags
  if (typeof tag === 'string') values.push(tag)
  if (Array.isArray(tags)) values.push(...tags.filter((item): item is string => typeof item === 'string'))
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
