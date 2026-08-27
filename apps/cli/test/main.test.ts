import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/main.js'

const originalWrite = process.stdout.write.bind(process.stdout)
const originalError = console.error

afterEach(() => {
  process.stdout.write = originalWrite
  console.error = originalError
  process.exitCode = 0
})

/** Runs a CLI command, capturing what it printed instead of letting it escape. */
async function run(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  console.error = (message?: unknown) => {
    stderr += `${String(message)}\n`
  }

  try {
    await main(argv)
  } finally {
    process.stdout.write = originalWrite
    console.error = originalError
  }
  return { stdout, stderr }
}

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pr-atlas-cli-'))
}

test('capture, target and sync form a working loop', async () => {
  const directory = await makeDir()
  const exported = join(directory, 'export')

  const captured = await run(['capture', '--url', 'https://example.com/x', '--title', 'X', '--tag', 'ai', '--data-dir', directory])
  const capture = (JSON.parse(captured.stdout) as { capture: { id: string; tags: string[] } }).capture
  assert.deepEqual(capture.tags, ['ai'])

  await run(['target', 'set', 'local', '--kind', 'file', '--config', JSON.stringify({ directory: exported }), '--data-dir', directory])

  // A single configured target needs no --target.
  const synced = JSON.parse((await run(['sync', '--data-dir', directory])).stdout) as {
    delivered: string[]
    outbox: Record<string, number>
  }
  assert.deepEqual(synced.delivered, [capture.id])
  assert.deepEqual(synced.outbox, { total: 1, pending: 0, sent: 1, failed: 0 })
  assert.deepEqual(await readdir(exported), [`${capture.id}.json`])

  const status = JSON.parse((await run(['status', '--data-dir', directory])).stdout) as {
    outbox: Record<string, number>
    targets: unknown[]
    connectors: string[]
  }
  assert.deepEqual(status.outbox, { total: 1, pending: 0, sent: 1, failed: 0 })
  assert.equal(status.targets.length, 1)
  assert.deepEqual(status.connectors, ['generic-web', 'priority-me-blog'])
})

test('re-capturing the same URL does not duplicate an already delivered entry', async () => {
  const directory = await makeDir()
  await run(['capture', '--url', 'https://example.com/dup', '--data-dir', directory])
  await run(['target', 'set', 'local', '--kind', 'file', '--config', JSON.stringify({ directory: join(directory, 'out') }), '--data-dir', directory])
  await run(['sync', '--data-dir', directory])
  await run(['capture', '--url', 'https://example.com/dup', '--data-dir', directory])

  const status = JSON.parse((await run(['status', '--data-dir', directory])).stdout) as {
    outbox: Record<string, number>
  }
  assert.deepEqual(status.outbox, { total: 1, pending: 0, sent: 1, failed: 0 })
})

test('an unknown command reports the error and fails the exit code', async () => {
  const { stderr } = await run(['definitely-not-a-command'])
  assert.match(stderr, /Unknown command: definitely-not-a-command/)
  assert.equal(process.exitCode, 1)
})

test('capture requires exactly one of --url or --text', async () => {
  assert.match((await run(['capture'])).stderr, /exactly one of --url or --text/)
  assert.match(
    (await run(['capture', '--url', 'https://x.example', '--text', 'hi'])).stderr,
    /exactly one of --url or --text/,
  )
})

test('config set rejects config that violates the connector schema', async () => {
  const directory = await makeDir()
  const { stderr } = await run([
    'config', 'set', 'bad', '--connector', 'generic-web', '--config', '{"urlx":"x"}', '--data-dir', directory,
  ])
  assert.match(stderr, /config\.url is required/)
  assert.match(stderr, /did you mean "url"/)
})

test('target set rejects config that violates the target schema', async () => {
  const directory = await makeDir()
  const { stderr } = await run([
    'target', 'set', 'bad', '--kind', 'webhook', '--config', '{"url":"not-a-uri"}', '--data-dir', directory,
  ])
  assert.match(stderr, /url must be a valid absolute URI/)

  const unknownKind = await run([
    'target', 'set', 'bad', '--kind', 'carrier-pigeon', '--config', '{}', '--data-dir', directory,
  ])
  assert.match(unknownKind.stderr, /Unknown target kind: carrier-pigeon/)
})

test('sync without a configured target says how to add one', async () => {
  const { stderr } = await run(['sync', '--data-dir', await makeDir()])
  assert.match(stderr, /No delivery target configured/)
  assert.match(stderr, /atlas target set/)
})

test('sync with several targets refuses to guess', async () => {
  const directory = await makeDir()
  await run(['target', 'set', 'a', '--kind', 'file', '--config', JSON.stringify({ directory: join(directory, 'a') }), '--data-dir', directory])
  await run(['target', 'set', 'b', '--kind', 'file', '--config', JSON.stringify({ directory: join(directory, 'b') }), '--data-dir', directory])

  const { stderr } = await run(['sync', '--data-dir', directory])
  assert.match(stderr, /Multiple delivery targets configured; pass --target <a\|b>/)
})

test('connector run needs an instance or inline config', async () => {
  const { stderr } = await run(['connector', 'run', 'generic-web', '--data-dir', await makeDir()])
  assert.match(stderr, /requires --config or --instance/)
})

test('connector run reports an unknown instance instead of collecting', async () => {
  const { stderr } = await run([
    'connector', 'run', 'generic-web', '--instance', 'nope', '--data-dir', await makeDir(),
  ])
  assert.match(stderr, /Unknown connector instance: nope/)
})

test('connector list and target kinds expose their schemas', async () => {
  const connectors = JSON.parse((await run(['connector', 'list'])).stdout) as Array<{ id: string }>
  assert.deepEqual(connectors.map(item => item.id), ['generic-web', 'priority-me-blog'])

  const kinds = JSON.parse((await run(['target', 'kinds'])).stdout) as Array<{ kind: string }>
  assert.deepEqual(kinds.map(item => item.kind), ['file', 'webhook'])
})

test('retry moves failed entries back to pending', async () => {
  const directory = await makeDir()
  await run(['capture', '--url', 'https://example.com/retry', '--data-dir', directory])
  await run(['target', 'set', 'remote', '--kind', 'webhook', '--config', JSON.stringify({ url: 'https://sink.invalid/hook' }), '--data-dir', directory])

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  try {
    const failed = JSON.parse((await run(['sync', '--data-dir', directory])).stdout) as {
      failed: unknown[]
      outbox: Record<string, number>
    }
    assert.equal(failed.failed.length, 1)
    assert.equal(failed.outbox.failed, 1)
  } finally {
    globalThis.fetch = originalFetch
  }

  const retried = JSON.parse((await run(['retry', '--data-dir', directory])).stdout) as {
    count: number
    outbox: Record<string, number>
  }
  assert.equal(retried.count, 1)
  assert.deepEqual(retried.outbox, { total: 1, pending: 1, sent: 0, failed: 0 })
})

test('help documents the delivery commands and incremental behaviour', async () => {
  const { stdout } = await run(['help'])
  assert.match(stdout, /atlas sync/)
  assert.match(stdout, /atlas target/)
  assert.match(stdout, /--full/)
  assert.match(stdout, /Runs are incremental/)
})
