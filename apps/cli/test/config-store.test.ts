import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigStore } from '../src/runtime/config.js'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pr-lore-config-'))
}

async function writeRaw(directory: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'config.json'), contents, 'utf8')
}

test('a missing config file reads as empty rather than failing', async () => {
  const store = new ConfigStore(await makeDir())
  assert.deepEqual(await store.load(), { version: 1, instances: [], targets: [] })
})

test('instances round-trip through upsert, get and remove', async () => {
  const store = new ConfigStore(await makeDir())
  await store.upsert({
    id: 'blog',
    connector: 'priority-me-blog',
    enabled: true,
    schedule: '0 3 * * *',
    config: { repository_url: 'https://github.com/owner/repo' },
    checkpoint: null,
  })

  assert.equal((await store.get('blog'))?.connector, 'priority-me-blog')
  assert.equal(await store.get('missing'), null)

  await store.upsert({
    id: 'blog',
    connector: 'priority-me-blog',
    enabled: false,
    schedule: null,
    config: { repository_url: 'https://github.com/owner/other' },
    checkpoint: { tree_sha: 'abc' },
  })
  const updated = await store.get('blog')
  assert.equal(updated?.enabled, false)
  assert.deepEqual(updated?.checkpoint, { tree_sha: 'abc' })
  assert.equal((await store.load()).instances.length, 1, 'upsert must not duplicate')

  assert.equal(await store.remove('blog'), true)
  assert.equal(await store.remove('blog'), false)
})

test('targets round-trip independently of instances', async () => {
  const store = new ConfigStore(await makeDir())
  await store.upsert({
    id: 'blog',
    connector: 'generic-web',
    enabled: true,
    schedule: null,
    config: { url: 'https://example.com' },
    checkpoint: null,
  })
  await store.upsertTarget({ id: 'local', kind: 'file', config: { directory: '/tmp/out' } })
  await store.upsertTarget({ id: 'remote', kind: 'webhook', config: { url: 'https://sink.example' } })

  const config = await store.load()
  assert.deepEqual(config.targets.map(target => target.id), ['local', 'remote'])
  assert.equal(config.instances.length, 1, 'targets must not disturb instances')

  assert.equal((await store.getTarget('remote'))?.kind, 'webhook')
  assert.equal(await store.removeTarget('remote'), true)
  assert.equal(await store.removeTarget('remote'), false)
  assert.equal((await store.load()).targets.length, 1)
})

test('a config file written before targets existed still loads', async () => {
  const directory = await makeDir()
  await writeRaw(
    directory,
    JSON.stringify({
      version: 1,
      instances: [{ id: 'blog', connector: 'generic-web', enabled: true, schedule: null, config: {}, checkpoint: null }],
    }),
  )
  const config = await new ConfigStore(directory).load()
  assert.deepEqual(config.targets, [])
  assert.equal(config.instances.length, 1)
})

test('absent optional instance fields are filled with defaults', async () => {
  const directory = await makeDir()
  await writeRaw(directory, JSON.stringify({ instances: [{ id: 'blog', connector: 'generic-web' }] }))
  assert.deepEqual((await new ConfigStore(directory).load()).instances, [
    { id: 'blog', connector: 'generic-web', enabled: true, schedule: null, config: {}, checkpoint: null },
  ])
})

test('a hand-edited config fails loudly instead of running on coerced values', async () => {
  const directory = await makeDir()

  await writeRaw(directory, 'not json')
  await assert.rejects(new ConfigStore(directory).load(), /is not valid JSON/)

  await writeRaw(directory, JSON.stringify({ instances: {} }))
  await assert.rejects(new ConfigStore(directory).load(), /instances must be an array/)

  await writeRaw(directory, JSON.stringify({ instances: [{ id: 'a', connector: 'x', enabled: 'yes' }] }))
  await assert.rejects(new ConfigStore(directory).load(), /non-boolean enabled/)

  await writeRaw(directory, JSON.stringify({ instances: [{ connector: 'x' }] }))
  await assert.rejects(new ConfigStore(directory).load(), /non-empty id/)

  await writeRaw(directory, JSON.stringify({ instances: [], targets: [{ id: 't', kind: 'ftp' }] }))
  await assert.rejects(new ConfigStore(directory).load(), /unknown kind; supported kinds are file, webhook/)
})
