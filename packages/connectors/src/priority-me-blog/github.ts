import { describeNetworkFailure } from '../shared/http.js'

const GITHUB_API = 'https://api.github.com'

export interface GitHubRepository {
  owner: string
  repo: string
  branchFromUrl: string | null
  contentDirFromUrl: string | null
}

export interface GitHubTreeEntry {
  path: string
  type: string
  sha: string
  url: string
}

export interface GitHubTreeResponse {
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

export function parseGitHubRepository(value: string): GitHubRepository {
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
    contentDirFromUrl = parts.slice(4).join('/') || null
  }
  return { owner, repo, branchFromUrl, contentDirFromUrl }
}

export function githubHeaders(tokenEnv: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pr-lore/0.2.0',
  }
  const token = tokenEnv ? process.env[tokenEnv]?.trim() : undefined
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export function encodePath(value: string): string {
  return value.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export function githubBlobUrl(repository: GitHubRepository, ref: string, path: string): string {
  return `https://github.com/${repository.owner}/${repository.repo}/blob/${encodePath(ref)}/${encodePath(path)}`
}

export class GitHubClient {
  constructor(
    private readonly headers: Record<string, string>,
    private readonly timeoutMs = 20_000,
  ) {}

  async defaultBranch(repository: GitHubRepository): Promise<string | null> {
    const info = await this.json<GitHubRepositoryResponse>(
      `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
    )
    return info.default_branch ?? null
  }

  async tree(repository: GitHubRepository, ref: string): Promise<GitHubTreeResponse> {
    return this.json<GitHubTreeResponse>(
      `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
        `/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )
  }

  async blobText(url: string): Promise<string> {
    const body = await this.json<GitHubBlobResponse>(url)
    if (body.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`GitHub blob response is not base64: ${url}`)
    }
    return Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8')
  }

  private async json<T>(url: string): Promise<T> {
    let response: Response
    try {
      response = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      // Reason: a network-level failure surfaces as a bare "fetch failed",
      // which tells the operator nothing about what was being reached.
      throw describeNetworkFailure(error, url, this.timeoutMs, 'GitHub')
    }

    const body = await response.text()
    if (!response.ok) throw this.describeFailure(response, url, body)
    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error(`GitHub request returned invalid JSON: ${url}`)
    }
  }

  /**
   * Turns an HTTP failure into something the operator can act on. A bare
   * "HTTP 403" is indistinguishable between a bad token and an exhausted rate
   * limit, which are opposite fixes.
   */
  private describeFailure(response: Response, url: string, body: string): Error {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const authenticated = 'Authorization' in this.headers

    if ((response.status === 403 || response.status === 429) && remaining === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      const resetAt = Number.isFinite(reset) && reset > 0
        ? new Date(reset * 1000).toISOString()
        : 'an unknown time'
      const advice = authenticated
        ? 'Wait for the window to reset or narrow config.content_dir.'
        : 'Set config.token_env to raise the limit from 60 to 5000 requests per hour.'
      return new Error(
        `GitHub API rate limit exhausted (resets at ${resetAt}). ${advice}`,
      )
    }

    if (response.status === 401 || response.status === 403) {
      return new Error(
        `GitHub denied the request: HTTP ${response.status} ${url}. ` +
          (authenticated
            ? 'The token in config.token_env may be expired or lack repository access.'
            : 'This repository looks private; set config.token_env.'),
      )
    }

    if (response.status === 404) {
      return new Error(
        `GitHub resource not found: ${url}. Check repository_url, branch and content_dir.`,
      )
    }

    const detail = body.trim().slice(0, 200)
    return new Error(`GitHub request failed: HTTP ${response.status} ${url}${detail ? ` — ${detail}` : ''}`)
  }
}
