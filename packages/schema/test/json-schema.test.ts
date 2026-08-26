import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchema } from '../src/json-schema.js'
import { assertConnectorInstance } from '../src/index.js'

const CONNECTOR_SCHEMA = {
  type: 'object',
  required: ['repository_url'],
  additionalProperties: false,
  properties: {
    repository_url: { type: 'string', format: 'uri' },
    branch: { type: 'string' },
    retries: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    privacy_level: { type: 'string', enum: ['public', 'private', 'sensitive'] },
    allow_cloud_llm: { type: 'boolean' },
  },
}

test('validateJsonSchema accepts a well-formed config', () => {
  assert.deepEqual(
    validateJsonSchema(CONNECTOR_SCHEMA, {
      repository_url: 'https://github.com/owner/repo',
      branch: 'main',
      retries: 3,
      tags: ['a', 'b'],
      privacy_level: 'private',
      allow_cloud_llm: false,
    }),
    [],
  )
})

test('validateJsonSchema reports missing required fields', () => {
  const errors = validateJsonSchema(CONNECTOR_SCHEMA, { branch: 'main' })
  assert.deepEqual(errors, ['config.repository_url is required'])
})

test('validateJsonSchema reports type mismatches with the received type', () => {
  const errors = validateJsonSchema(CONNECTOR_SCHEMA, {
    repository_url: 'https://example.com',
    allow_cloud_llm: 'yes',
  })
  assert.deepEqual(errors, ['allow_cloud_llm must be boolean, received string'])
})

test('validateJsonSchema rejects unknown options and suggests a close match', () => {
  const errors = validateJsonSchema(CONNECTOR_SCHEMA, {
    repository_url: 'https://example.com',
    branchh: 'main',
  })
  assert.deepEqual(errors, ['config.branchh is not a recognized option (did you mean "branch"?)'])
})

test('validateJsonSchema omits a suggestion when nothing is close', () => {
  const errors = validateJsonSchema(CONNECTOR_SCHEMA, {
    repository_url: 'https://example.com',
    completely_unrelated: 1,
  })
  assert.deepEqual(errors, ['config.completely_unrelated is not a recognized option'])
})

test('validateJsonSchema enforces enum, format and array item types', () => {
  assert.deepEqual(
    validateJsonSchema(CONNECTOR_SCHEMA, {
      repository_url: 'https://example.com',
      privacy_level: 'secret',
    }),
    ['privacy_level must be one of "public", "private", "sensitive"'],
  )
  assert.deepEqual(
    validateJsonSchema(CONNECTOR_SCHEMA, { repository_url: 'not-a-uri' }),
    ['repository_url must be a valid absolute URI'],
  )
  assert.deepEqual(
    validateJsonSchema(CONNECTOR_SCHEMA, { repository_url: 'https://example.com', tags: ['ok', 7] }),
    ['tags[1] must be string, received number'],
  )
})

test('validateJsonSchema distinguishes integer from number and rejects arrays as objects', () => {
  assert.deepEqual(
    validateJsonSchema(CONNECTOR_SCHEMA, { repository_url: 'https://example.com', retries: 1.5 }),
    ['retries must be integer, received number'],
  )
  assert.deepEqual(validateJsonSchema(CONNECTOR_SCHEMA, []), ['config must be object, received array'])
  assert.deepEqual(validateJsonSchema(CONNECTOR_SCHEMA, null), ['config must be object, received null'])
})

test('validateJsonSchema ignores unknown keywords and non-object schemas', () => {
  assert.deepEqual(validateJsonSchema({ type: 'string', description: 'doc', default: 'x' }, 'value'), [])
  assert.deepEqual(validateJsonSchema(true as never, { anything: 1 }), [])
})

test('assertConnectorInstance fills defaults but rejects wrong types', () => {
  assert.deepEqual(assertConnectorInstance({ id: 'a', connector: 'generic-web' }), {
    id: 'a',
    connector: 'generic-web',
    enabled: true,
    schedule: null,
    config: {},
    checkpoint: null,
  })
  assert.throws(() => assertConnectorInstance({ connector: 'x' }), /non-empty id/)
  assert.throws(() => assertConnectorInstance({ id: 'a' }), /requires a connector id/)
  assert.throws(() => assertConnectorInstance({ id: 'a', connector: 'x', enabled: 'yes' }), /non-boolean enabled/)
  assert.throws(() => assertConnectorInstance({ id: 'a', connector: 'x', config: [] }), /non-object config/)
})
