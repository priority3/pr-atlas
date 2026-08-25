import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManualCapture, OutboxStore } from '../src/index.js'

test('manual captures support URL and text payloads with stable IDs', () => {
  const url = createManualCapture({ uri: 'https://example.com/article', title: 'Article', now: '2026-08-25T00:00:00.000Z' })
  const urlAgain = createManualCapture({ uri: 'https://example.com/article', title: 'Article', now: '2026-08-26T00:00:00.000Z' })
  assert.equal(url.payload.kind, 'reference')
  assert.equal(url.subject.kind, 'url')
  assert.equal(url.id, urlAgain.id)

  const text = createManualCapture({ uri: 'text://manual/one', text: 'A remembered thought', title: 'Thought' })
  assert.equal(text.payload.kind, 'text')
  assert.equal(text.payload.text, 'A remembered thought')
  assert.equal(text.subject.kind, 'text')
})

test('outbox enqueue is idempotent and preserves delivery status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-lore-core-'))
  const store = new OutboxStore(directory)
  const capture = createManualCapture({ uri: 'https://example.com/idempotent' })
  const first = await store.enqueue(capture)
  const sent = await store.mark(capture.id, 'sent')
  const duplicate = await store.enqueue({ ...capture, run_id: 'different-run' })
  assert.equal(first.status, 'pending')
  assert.equal(sent.status, 'sent')
  assert.equal(duplicate.status, 'sent')
  assert.deepEqual(await store.summary(), { total: 1, pending: 0, sent: 1, failed: 0 })
})
