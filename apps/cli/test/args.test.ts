import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasFlag, option, options, parseArgs } from '../src/inputs/args.js'

test('CLI argument parser supports repeated options and flags', () => {
  const args = parseArgs(['--tag', 'one', '--tag=two', '--save', 'connector', '--data-dir', '/tmp/lore'])
  assert.deepEqual(options(args, 'tag'), ['one', 'two'])
  assert.equal(option(args, 'data-dir'), '/tmp/lore')
  assert.equal(hasFlag(args, 'save'), true)
  assert.deepEqual(args.positionals, ['connector'])
})
