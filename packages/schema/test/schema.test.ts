import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertValidCapture, hashText, stableId } from '../src/index.js'

test('hash and stable id helpers are deterministic', () => {
  assert.equal(hashText('hello'), hashText('hello'))
  assert.notEqual(hashText('hello'), hashText('world'))
  assert.equal(stableId('cap', 'seed'), stableId('cap', 'seed'))
  assert.match(stableId('cap', 'seed'), /^cap_[0-9a-f]{20}$/)
})

test('assertValidCapture rejects incomplete values', () => {
  assert.throws(() => assertValidCapture({}), /Unsupported capture schema/)
  assert.throws(
    () =>
      assertValidCapture({
        schema_version: 'lore.capture.v1',
        id: 'cap_test',
        connector: 'manual',
        observed_at: 'now',
        captured_at: 'now',
      }),
    /subject.kind and subject.uri/,
  )
})
