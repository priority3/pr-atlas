import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManualCapture } from '../src/capture.js'
import { OutboxStore } from '../src/outbox.js'

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pr-atlas-outbox-'))
}

test('status is the entry location, so marking moves the file', async () => {
  const root = await makeRoot()
  const store = new OutboxStore(root)
  const capture = createManualCapture({ uri: 'https://example.com/a' })

  await store.enqueue(capture)
  assert.deepEqual(await readdir(join(root, 'outbox', 'pending')), [`${capture.id}.json`])

  await store.mark(capture.id, 'sent')
  assert.deepEqual(await readdir(join(root, 'outbox', 'pending')), [])
  assert.deepEqual(await readdir(join(root, 'outbox', 'sent')), [`${capture.id}.json`])

  // The body must agree with the location it now lives in.
  const raw = await readFile(join(root, 'outbox', 'sent', `${capture.id}.json`), 'utf8')
  assert.equal(JSON.parse(raw).status, 'sent')
})

test('marking failed increments attempts and records the error', async () => {
  const root = await makeRoot()
  const store = new OutboxStore(root)
  const capture = createManualCapture({ uri: 'https://example.com/b' })
  await store.enqueue(capture)

  const first = await store.mark(capture.id, 'failed', 'boom')
  assert.equal(first.attempts, 1)
  assert.equal(first.last_error, 'boom')

  const retried = await store.mark(capture.id, 'pending', null)
  assert.equal(retried.attempts, 1, 'returning to pending must not count as an attempt')
  assert.equal(retried.last_error, null)

  const second = await store.mark(capture.id, 'failed', 'boom again')
  assert.equal(second.attempts, 2)
  assert.deepEqual(await store.summary(), { total: 1, pending: 0, sent: 0, failed: 1 })
})

test('summary counts by listing directories, never by parsing entry bodies', async () => {
  const root = await makeRoot()
  const store = new OutboxStore(root)
  await store.enqueue(createManualCapture({ uri: 'https://example.com/c' }))

  // Reason: an unparseable file would throw if summary() read entry bodies.
  // Counting purely from directory listings is what makes this pass.
  await writeFile(join(root, 'outbox', 'sent', 'corrupt.json'), 'not json at all', 'utf8')

  assert.deepEqual(await store.summary(), { total: 2, pending: 1, sent: 1, failed: 0 })
})

test('temporary write files are never counted or listed', async () => {
  const root = await makeRoot()
  const store = new OutboxStore(root)
  await store.enqueue(createManualCapture({ uri: 'https://example.com/d' }))
  await writeFile(join(root, 'outbox', 'pending', 'cap_leftover.json.tmp'), '{}', 'utf8')

  assert.deepEqual(await store.summary(), { total: 1, pending: 1, sent: 0, failed: 0 })
  assert.equal((await store.list()).length, 1)
})

test('a legacy flat outbox is migrated into status directories on first access', async () => {
  const root = await makeRoot()
  const outbox = join(root, 'outbox')
  await mkdir(outbox, { recursive: true })

  const sent = createManualCapture({ uri: 'https://example.com/legacy-sent' })
  const pending = createManualCapture({ uri: 'https://example.com/legacy-pending' })
  await writeFile(
    join(outbox, `${sent.id}.json`),
    JSON.stringify({ capture: sent, status: 'sent', attempts: 0, last_error: null, updated_at: 'x' }),
    'utf8',
  )
  await writeFile(
    join(outbox, `${pending.id}.json`),
    JSON.stringify({ capture: pending, status: 'pending', attempts: 0, last_error: null, updated_at: 'x' }),
    'utf8',
  )
  // An unreadable legacy file must stay visible rather than disappear.
  await writeFile(join(outbox, 'cap_broken.json'), 'garbage', 'utf8')

  const store = new OutboxStore(root)
  assert.deepEqual(await store.summary(), { total: 3, pending: 2, sent: 1, failed: 0 })
  assert.deepEqual(await readdir(join(outbox, 'sent')), [`${sent.id}.json`])
  assert.equal(
    (await readdir(outbox)).filter(name => name.endsWith('.json')).length,
    0,
    'no flat files should remain at the outbox root',
  )

  // Migrated entries keep their status, so re-enqueue stays idempotent.
  assert.equal((await store.enqueue(sent)).status, 'sent')
})

test('list filters by status and remove clears an entry from every directory', async () => {
  const root = await makeRoot()
  const store = new OutboxStore(root)
  const a = createManualCapture({ uri: 'https://example.com/e' })
  const b = createManualCapture({ uri: 'https://example.com/f' })
  await store.enqueue(a)
  await store.enqueue(b)
  await store.mark(b.id, 'failed', 'nope')

  assert.deepEqual((await store.list('pending')).map(entry => entry.capture.id), [a.id])
  assert.deepEqual((await store.list('failed')).map(entry => entry.capture.id), [b.id])
  assert.equal((await store.list()).length, 2)

  await store.remove(b.id)
  assert.deepEqual(await store.summary(), { total: 1, pending: 1, sent: 0, failed: 0 })
})

test('marking an unknown entry fails loudly', async () => {
  const store = new OutboxStore(await makeRoot())
  await assert.rejects(store.mark('cap_missing', 'sent'), /Unknown outbox entry/)
})
