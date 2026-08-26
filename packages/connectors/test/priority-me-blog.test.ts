import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { assertValidCapture, type ConnectorContext, type JsonValue } from '@pr-lore/schema'
import { createPriorityMeBlogConnector } from '../src/priority-me-blog/index.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('priority-me-blog reads GitHub Markdown and ignores leetcode content', async () => {
  const calls: string[] = []
  installGitHubFixture(calls)
  const connector = createPriorityMeBlogConnector()
  const context = createContext()

  const first = await connector.collect(context)
  assert.equal(first.captures.length, 2)
  assert.deepEqual(
    first.captures.map(capture => capture.metadata.path),
    ['src/content/blogs/Hello World.md', 'src/content/blogs/nested/Second.mdoc'],
  )

  const hello = first.captures[0]
  assert.ok(hello)
  assertValidCapture(hello)
  assert.equal(hello.subject.title, 'GitHub Blog')
  assert.equal(hello.subject.url, 'https://razet.me/posts/hello-world')
  assert.equal(hello.payload.kind, 'markdown')
  assert.equal(hello.payload.text, '# Hello\n\nThis is a blog.')
  assert.equal(hello.payload.raw_ref, 'https://github.com/example/priority.me/blob/main/src/content/blogs/Hello%20World.md')
  assert.equal(hello.metadata.collection, 'blogs')
  assert.equal(hello.privacy.level, 'private')
  assert.equal(hello.privacy.allow_cloud_llm, false)
  assert.deepEqual(hello.tags, ['tech', 'memory'])
  assert.match(hello.payload.content_hash ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.equal(hello.provenance.cursor, 'sha-blog-1')
  assert.equal(first.captures[1]?.subject.url, 'https://razet.me/posts/nested/second')

  const second = await connector.collect({
    ...context,
    run_id: 'run-different',
    now: '2026-08-26T00:00:00.000Z',
  })
  assert.equal(second.captures[0]?.id, hello.id)
  assert.equal(first.checkpoint?.tree_sha, 'tree-sha')
  assert.ok(calls.some(url => url.includes('/git/trees/main?recursive=1')))
  assert.ok(!calls.some(url => url.includes('leetcode')))
})

test('priority-me-blog accepts a GitHub tree URL and optional token environment', async () => {
  const calls: string[] = []
  installGitHubFixture(calls)
  process.env.PR_LORE_TEST_TOKEN = 'test-token'
  try {
    const connector = createPriorityMeBlogConnector()
    const result = await connector.collect({
      ...createContext({
        repository_url: 'https://github.com/example/priority.me/tree/main/src/content/blogs',
        token_env: 'PR_LORE_TEST_TOKEN',
      }),
    })
    assert.equal(result.captures.length, 2)
    assert.ok(calls.every(url => url.startsWith('https://')))
    assert.equal(result.checkpoint?.content_dir, 'src/content/blogs')
  } finally {
    delete process.env.PR_LORE_TEST_TOKEN
  }
})

test('priority-me-blog rejects a local path as its source', async () => {
  const connector = createPriorityMeBlogConnector()
  await assert.rejects(
    connector.collect(
      createContext({ repository_url: '/Users/moka/Documents/da-code/priority.me' }),
    ),
    /valid GitHub URL|point to github.com/,
  )
})

test('priority-me-blog rejects a GitHub file URL as a repository source', async () => {
  const connector = createPriorityMeBlogConnector()
  await assert.rejects(
    connector.collect(
      createContext({ repository_url: 'https://github.com/example/priority.me/blob/main/README.md' }),
    ),
    /repository or tree URL/,
  )
})

function createContext(overrides: Record<string, JsonValue> = {}): ConnectorContext {
  const config = {
    repository_url: 'https://github.com/example/priority.me',
    site_url: 'https://razet.me',
    ...overrides,
  }
  return {
    instance: {
      id: 'priority-me',
      connector: 'priority-me-blog',
      enabled: true,
      schedule: '0 3 * * *',
      config,
      checkpoint: null,
    },
    run_id: 'run-test',
    trigger: 'manual',
    now: '2026-08-25T00:00:00.000Z',
  }
}

function installGitHubFixture(calls: string[]): void {
  const tree = {
    sha: 'tree-sha',
    truncated: false,
    tree: [
      {
        path: 'src/content/blogs/Hello World.md',
        type: 'blob',
        sha: 'sha-blog-1',
        url: 'https://api.github.com/repos/example/priority.me/git/blobs/sha-blog-1',
      },
      {
        path: 'src/content/blogs/nested/Second.mdoc',
        type: 'blob',
        sha: 'sha-blog-2',
        url: 'https://api.github.com/repos/example/priority.me/git/blobs/sha-blog-2',
      },
      {
        path: 'src/content/leetcode/Should-not.md',
        type: 'blob',
        sha: 'sha-leetcode',
        url: 'https://api.github.com/repos/example/priority.me/git/blobs/sha-leetcode',
      },
    ],
  }
  const blobs: Record<string, string> = {
    'sha-blog-1': ['---', 'title: GitHub Blog', 'tags: [tech, memory]', '---', '# Hello', '', 'This is a blog.'].join('\n'),
    'sha-blog-2': ['---', 'title: Second Note', 'tag: notes', '---', 'Second body.'].join('\n'),
  }

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://api.github.com/repos/example/priority.me') {
      const authorization = new Headers(init?.headers).get('Authorization')
      if (authorization) assert.equal(authorization, 'Bearer test-token')
      return jsonResponse({ default_branch: 'main' })
    }
    if (url === 'https://api.github.com/repos/example/priority.me/git/trees/main?recursive=1') {
      return jsonResponse(tree)
    }
    const blobMatch = url.match(/\/git\/blobs\/(sha-[^/?]+)$/)
    const blob = blobMatch?.[1] ? blobs[blobMatch[1]] : undefined
    if (blob) {
      return jsonResponse({ encoding: 'base64', content: Buffer.from(blob, 'utf8').toString('base64') })
    }
    return jsonResponse({ message: `unexpected URL: ${url}` }, 404)
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// --- incremental collection ---------------------------------------------------

interface RepoFile {
  path: string
  sha: string
  body: string
}

const BLOG_DIR = 'src/content/blogs'

function post(title: string): string {
  return ['---', `title: ${title}`, '---', `Body of ${title}.`].join('\n')
}

function blobUrlFor(sha: string): string {
  return `https://api.github.com/repos/example/priority.me/git/blobs/${sha}`
}

function installRepo(calls: string[], options: { treeSha: string; files: RepoFile[] }): void {
  globalThis.fetch = async input => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://api.github.com/repos/example/priority.me') {
      return jsonResponse({ default_branch: 'main' })
    }
    if (url.includes('/git/trees/')) {
      return jsonResponse({
        sha: options.treeSha,
        truncated: false,
        tree: options.files.map(file => ({
          path: file.path,
          type: 'blob',
          sha: file.sha,
          url: blobUrlFor(file.sha),
        })),
      })
    }
    const sha = url.split('/').pop()
    const file = options.files.find(candidate => candidate.sha === sha)
    if (!file) return jsonResponse({ message: `unexpected URL: ${url}` }, 404)
    return jsonResponse({
      encoding: 'base64',
      content: Buffer.from(file.body, 'utf8').toString('base64'),
    })
  }
}

function contextWith(
  checkpoint: Record<string, JsonValue> | null,
  overrides: Record<string, JsonValue> = {},
): ConnectorContext {
  const base = createContext(overrides)
  return { ...base, instance: { ...base.instance, checkpoint } }
}

function blobCalls(calls: string[]): string[] {
  return calls.filter(url => url.includes('/git/blobs/'))
}

test('an unchanged tree SHA skips every blob request', async () => {
  const calls: string[] = []
  const files: RepoFile[] = [
    { path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') },
    { path: `${BLOG_DIR}/b.md`, sha: 'sha-b', body: post('B') },
  ]
  installRepo(calls, { treeSha: 'tree-1', files })
  const connector = createPriorityMeBlogConnector()

  const first = await connector.collect(createContext())
  assert.equal(first.captures.length, 2)
  assert.equal(first.checkpoint?.changed, 2)
  assert.equal(blobCalls(calls).length, 2)

  calls.length = 0
  const second = await connector.collect(contextWith(first.checkpoint))
  assert.equal(second.captures.length, 0, 'nothing changed, so nothing is collected')
  assert.equal(second.checkpoint?.changed, 0)
  assert.deepEqual(blobCalls(calls), [], 'the whole point: zero blob requests')
  assert.equal(second.checkpoint?.tree_sha, 'tree-1')
})

test('only files whose blob SHA changed are refetched', async () => {
  const calls: string[] = []
  const original: RepoFile[] = [
    { path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') },
    { path: `${BLOG_DIR}/b.md`, sha: 'sha-b', body: post('B') },
  ]
  installRepo(calls, { treeSha: 'tree-1', files: original })
  const connector = createPriorityMeBlogConnector()
  const first = await connector.collect(createContext())

  calls.length = 0
  installRepo(calls, {
    treeSha: 'tree-2',
    files: [
      { path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') },
      { path: `${BLOG_DIR}/b.md`, sha: 'sha-b2', body: post('B revised') },
    ],
  })

  const second = await connector.collect(contextWith(first.checkpoint))
  assert.equal(second.captures.length, 1)
  assert.equal(second.captures[0]?.metadata.path, `${BLOG_DIR}/b.md`)
  assert.equal(second.captures[0]?.provenance.cursor, 'sha-b2')
  assert.equal(second.captures[0]?.subject.title, 'B revised')
  assert.deepEqual(blobCalls(calls), [blobUrlFor('sha-b2')], 'the unchanged file is not refetched')
  assert.equal(second.checkpoint?.changed, 1)

  // The checkpoint tracks every file, not only the changed ones.
  assert.deepEqual(second.checkpoint?.files, { [`${BLOG_DIR}/a.md`]: 'sha-a', [`${BLOG_DIR}/b.md`]: 'sha-b2' })
})

test('a new file is collected while existing files stay untouched', async () => {
  const calls: string[] = []
  const files: RepoFile[] = [{ path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') }]
  installRepo(calls, { treeSha: 'tree-1', files })
  const connector = createPriorityMeBlogConnector()
  const first = await connector.collect(createContext())

  calls.length = 0
  installRepo(calls, {
    treeSha: 'tree-2',
    files: [...files, { path: `${BLOG_DIR}/c.md`, sha: 'sha-c', body: post('C') }],
  })
  const second = await connector.collect(contextWith(first.checkpoint))

  assert.deepEqual(second.captures.map(capture => capture.metadata.path), [`${BLOG_DIR}/c.md`])
  assert.deepEqual(blobCalls(calls), [blobUrlFor('sha-c')])
})

test('a checkpoint for a different ref or directory forces a full scan', async () => {
  const calls: string[] = []
  const files: RepoFile[] = [
    { path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') },
    { path: `${BLOG_DIR}/b.md`, sha: 'sha-b', body: post('B') },
  ]
  installRepo(calls, { treeSha: 'tree-1', files })
  const connector = createPriorityMeBlogConnector()
  const first = await connector.collect(createContext())
  const checkpoint = first.checkpoint ?? {}

  const otherRef = await connector.collect(contextWith({ ...checkpoint, ref: 'release' }))
  assert.equal(otherRef.captures.length, 2)

  const otherDir = await connector.collect(contextWith({ ...checkpoint, content_dir: 'src/content/notes' }))
  assert.equal(otherDir.captures.length, 2)
})

test('a legacy checkpoint that stored only a file count forces a full scan', async () => {
  const calls: string[] = []
  installRepo(calls, {
    treeSha: 'tree-1',
    files: [
      { path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') },
      { path: `${BLOG_DIR}/b.md`, sha: 'sha-b', body: post('B') },
    ],
  })

  // Reason: earlier builds wrote `files: 2`. That matches the current tree SHA
  // but carries no per-file state, so it must not enable the fast path.
  const result = await createPriorityMeBlogConnector().collect(
    contextWith({
      scanned_at: '2026-08-24T00:00:00.000Z',
      repository: 'https://github.com/example/priority.me',
      ref: 'main',
      tree_sha: 'tree-1',
      content_dir: BLOG_DIR,
      files: 2,
    }),
  )
  assert.equal(result.captures.length, 2)
  assert.deepEqual(result.checkpoint?.files, {
    [`${BLOG_DIR}/a.md`]: 'sha-a',
    [`${BLOG_DIR}/b.md`]: 'sha-b',
  })
})

test('a configured branch avoids the extra default-branch request', async () => {
  const calls: string[] = []
  installRepo(calls, { treeSha: 'tree-1', files: [{ path: `${BLOG_DIR}/a.md`, sha: 'sha-a', body: post('A') }] })

  await createPriorityMeBlogConnector().collect(createContext({ branch: 'main' }))
  assert.ok(
    !calls.includes('https://api.github.com/repos/example/priority.me'),
    'the repository metadata request is only needed to discover the default branch',
  )
})

test('blob requests run in parallel but never exceed the pool limit', async () => {
  const files: RepoFile[] = Array.from({ length: 12 }, (_, index) => {
    const name = String(index).padStart(2, '0')
    return { path: `${BLOG_DIR}/post-${name}.md`, sha: `sha-${name}`, body: post(`Post ${name}`) }
  })

  let inFlight = 0
  let peak = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === 'https://api.github.com/repos/example/priority.me') {
      return jsonResponse({ default_branch: 'main' })
    }
    if (url.includes('/git/trees/')) {
      return jsonResponse({
        sha: 'tree-1',
        truncated: false,
        tree: files.map(file => ({ path: file.path, type: 'blob', sha: file.sha, url: blobUrlFor(file.sha) })),
      })
    }

    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight -= 1

    const sha = url.split('/').pop()
    const file = files.find(candidate => candidate.sha === sha)
    return jsonResponse({
      encoding: 'base64',
      content: Buffer.from(file?.body ?? '', 'utf8').toString('base64'),
    })
  }

  const result = await createPriorityMeBlogConnector().collect(createContext())
  assert.equal(result.captures.length, 12)
  assert.ok(peak > 1, `blob requests should overlap, but peak concurrency was ${peak}`)
  assert.ok(peak <= 4, `pool limit of 4 exceeded, peak concurrency was ${peak}`)
  assert.deepEqual(
    result.captures.map(capture => capture.metadata.path),
    files.map(file => file.path),
    'concurrent fetching must preserve input order',
  )
})

// --- error reporting ---------------------------------------------------------

function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1900000000',
    },
  })
}

test('an exhausted anonymous rate limit explains how to raise it', async () => {
  globalThis.fetch = async () => rateLimitedResponse()
  await assert.rejects(
    createPriorityMeBlogConnector().collect(createContext()),
    /rate limit exhausted \(resets at 2030-.*config\.token_env/s,
  )
})

test('an exhausted authenticated rate limit suggests narrowing the scan instead', async () => {
  globalThis.fetch = async () => rateLimitedResponse()
  process.env.PR_LORE_TEST_TOKEN = 'test-token'
  try {
    await assert.rejects(
      createPriorityMeBlogConnector().collect(createContext({ token_env: 'PR_LORE_TEST_TOKEN' })),
      /rate limit exhausted.*narrow config\.content_dir/s,
    )
  } finally {
    delete process.env.PR_LORE_TEST_TOKEN
  }
})

test('a 403 without an exhausted quota points at repository visibility', async () => {
  globalThis.fetch = async () => jsonResponse({ message: 'Not Found' }, 403)
  await assert.rejects(
    createPriorityMeBlogConnector().collect(createContext()),
    /looks private; set config\.token_env/,
  )
})

test('a 404 names the config fields worth checking', async () => {
  globalThis.fetch = async () => jsonResponse({ message: 'Not Found' }, 404)
  await assert.rejects(
    createPriorityMeBlogConnector().collect(createContext()),
    /not found.*Check repository_url, branch and content_dir/s,
  )
})

test('a network failure says what could not be reached, not just "fetch failed"', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(
    createPriorityMeBlogConnector().collect(createContext()),
    /Could not reach GitHub \(fetch failed\).*api\.github\.com.*network connectivity/s,
  )
})

test('a timeout is reported as a timeout', async () => {
  globalThis.fetch = async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  await assert.rejects(
    createPriorityMeBlogConnector().collect(createContext()),
    /timed out after 20000ms/,
  )
})

