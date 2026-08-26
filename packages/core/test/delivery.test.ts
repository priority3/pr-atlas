import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { LoreCapture } from '@pr-lore/schema'
import { createManualCapture } from '../src/capture.js'
import { OutboxStore } from '../src/outbox.js'
import {
  createDeliverer,
  createFileDeliverer,
  createWebhookDeliverer,
  syncOutbox,
  type Deliverer,
} from '../src/delivery.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.PR_LORE_TEST_WEBHOOK_TOKEN
})

async function makeStore(): Promise<{ store: OutboxStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pr-lore-delivery-'))
  return { store: new OutboxStore(root), root }
}

test('file target exports each capture and marks it sent', async () => {
  const { store, root } = await makeStore()
  const a = createManualCapture({ uri: 'https://example.com/a' })
  const b = createManualCapture({ uri: 'https://example.com/b' })
  await store.enqueue(a)
  await store.enqueue(b)

  const destination = join(root, 'export')
  const summary = await syncOutbox(store, createFileDeliverer({ directory: destination }, 'local'))

  assert.equal(summary.target, 'local')
  assert.equal(summary.attempted, 2)
  assert.equal(summary.delivered.length, 2)
  assert.deepEqual(summary.failed, [])
  assert.deepEqual(summary.skipped, [])
  assert.deepEqual(await store.summary(), { total: 2, pending: 0, sent: 2, failed: 0 })

  assert.deepEqual((await readdir(destination)).sort(), [`${a.id}.json`, `${b.id}.json`].sort())
  const exported = JSON.parse(await readFile(join(destination, `${a.id}.json`), 'utf8')) as LoreCapture
  assert.equal(exported.id, a.id)
  assert.equal(exported.schema_version, 'lore.capture.v1')
})

test('a throwing target records the failure and increments attempts', async () => {
  const { store } = await makeStore()
  const capture = createManualCapture({ uri: 'https://example.com/fail' })
  await store.enqueue(capture)

  const broken: Deliverer = {
    id: 'broken',
    kind: 'file',
    deliver: async () => {
      throw new Error('disk on fire')
    },
  }
  const summary = await syncOutbox(store, broken)

  assert.deepEqual(summary.delivered, [])
  assert.deepEqual(summary.failed, [{ id: capture.id, error: 'disk on fire' }])
  assert.deepEqual(await store.summary(), { total: 1, pending: 0, sent: 0, failed: 1 })

  const [entry] = await store.list('failed')
  assert.equal(entry?.attempts, 1)
  assert.equal(entry?.last_error, 'disk on fire')
})

test('network targets skip sensitive captures by default and stay pending', async () => {
  const { store } = await makeStore()
  const normal = createManualCapture({ uri: 'https://example.com/ok' })
  const secret = createManualCapture({ uri: 'https://example.com/secret', privacy_level: 'sensitive' })
  await store.enqueue(normal)
  await store.enqueue(secret)

  const seen: string[] = []
  globalThis.fetch = async input => {
    seen.push(String(input))
    return new Response('{}', { status: 200 })
  }

  const summary = await syncOutbox(store, createWebhookDeliverer({ url: 'https://sink.example/hook' }))

  assert.deepEqual(summary.delivered, [normal.id])
  assert.equal(summary.attempted, 1, 'a skipped capture is not an attempt')
  assert.equal(summary.skipped.length, 1)
  assert.equal(summary.skipped[0]?.id, secret.id)
  assert.match(summary.skipped[0]?.reason ?? '', /sensitive/)
  assert.equal(seen.length, 1, 'the sensitive capture must never reach the network')

  // Skipped entries are neither sent nor failed: they remain pending.
  assert.deepEqual(await store.summary(), { total: 2, pending: 1, sent: 1, failed: 0 })
  assert.equal((await store.list('pending'))[0]?.capture.id, secret.id)
})

test('sensitive captures ship only when the target opts in explicitly', async () => {
  const { store, root } = await makeStore()
  const secret = createManualCapture({ uri: 'https://example.com/secret2', privacy_level: 'sensitive' })
  await store.enqueue(secret)

  const summary = await syncOutbox(
    store,
    createFileDeliverer({
      directory: join(root, 'export'),
      include_privacy_levels: ['sensitive'],
    }),
  )
  assert.deepEqual(summary.delivered, [secret.id])
  assert.deepEqual(summary.skipped, [])
})

test('limit caps delivery attempts and ids narrows the selection', async () => {
  const { store, root } = await makeStore()
  const captures = [1, 2, 3].map(index => createManualCapture({ uri: `https://example.com/${index}` }))
  for (const capture of captures) await store.enqueue(capture)

  const deliverer = createFileDeliverer({ directory: join(root, 'export') })
  const limited = await syncOutbox(store, deliverer, { limit: 2 })
  assert.equal(limited.attempted, 2)
  assert.deepEqual(await store.summary(), { total: 3, pending: 1, sent: 2, failed: 0 })

  const remaining = await store.list('pending')
  const targetId = remaining[0]?.capture.id ?? ''
  const byId = await syncOutbox(store, deliverer, { ids: [targetId] })
  assert.deepEqual(byId.delivered, [targetId])
})

test('webhook target posts the capture as JSON with a bearer token', async () => {
  const { store } = await makeStore()
  const capture = createManualCapture({ uri: 'https://example.com/hook' })
  await store.enqueue(capture)
  process.env.PR_LORE_TEST_WEBHOOK_TOKEN = 'secret-token'

  const observed: Array<{ url: string; method: string | null; auth: string | null; body: LoreCapture }> = []
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    observed.push({
      url: String(input),
      method: init?.method ?? null,
      auth: headers.get('authorization'),
      body: JSON.parse(String(init?.body)) as LoreCapture,
    })
    assert.equal(headers.get('content-type'), 'application/json')
    return new Response(null, { status: 204 })
  }

  const summary = await syncOutbox(
    store,
    createDeliverer('webhook', { url: 'https://sink.example/hook', token_env: 'PR_LORE_TEST_WEBHOOK_TOKEN' }, 'remote'),
  )

  assert.deepEqual(summary.delivered, [capture.id])
  assert.equal(observed[0]?.url, 'https://sink.example/hook')
  assert.equal(observed[0]?.method, 'POST')
  assert.equal(observed[0]?.auth, 'Bearer secret-token')
  assert.equal(observed[0]?.body.id, capture.id)
})

test('webhook failures surface the HTTP status and response body', async () => {
  const { store } = await makeStore()
  const capture = createManualCapture({ uri: 'https://example.com/hook-fail' })
  await store.enqueue(capture)

  globalThis.fetch = async () => new Response('quota exceeded', { status: 429 })
  const summary = await syncOutbox(store, createWebhookDeliverer({ url: 'https://sink.example/hook' }))

  assert.equal(summary.failed[0]?.id, capture.id)
  assert.match(summary.failed[0]?.error ?? '', /HTTP 429.*quota exceeded/)
})

test('a webhook target with an unset token env fails before sending anything', async () => {
  const { store } = await makeStore()
  await store.enqueue(createManualCapture({ uri: 'https://example.com/no-token' }))

  let called = false
  globalThis.fetch = async () => {
    called = true
    return new Response('', { status: 200 })
  }

  const summary = await syncOutbox(
    store,
    createWebhookDeliverer({ url: 'https://sink.example/hook', token_env: 'PR_LORE_MISSING_TOKEN' }),
  )
  assert.match(summary.failed[0]?.error ?? '', /PR_LORE_MISSING_TOKEN is not set/)
  assert.equal(called, false)
})

test('createDeliverer rejects malformed target config', () => {
  assert.throws(() => createDeliverer('file', {}, 'x'), /requires config.directory/)
  assert.throws(() => createDeliverer('webhook', { url: 'ftp://nope' }, 'x'), /http\(s\) config.url/)
})
