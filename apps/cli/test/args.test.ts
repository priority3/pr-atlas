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

test('boolean flags never swallow a following positional', () => {
  // Reason: without --full in the boolean set, "priority-me-blog" would be
  // parsed as the value of --full and vanish from the positionals.
  const args = parseArgs(['run', '--full', 'priority-me-blog', '--instance', 'blog'])
  assert.equal(hasFlag(args, 'full'), true)
  assert.equal(option(args, 'full'), null)
  assert.deepEqual(args.positionals, ['run', 'priority-me-blog'])
  assert.equal(option(args, 'instance'), 'blog')
})

test('everything after -- is treated as a positional', () => {
  const args = parseArgs(['run', '--', '--not-an-option'])
  assert.deepEqual(args.positionals, ['run', '--not-an-option'])
})
