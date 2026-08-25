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
