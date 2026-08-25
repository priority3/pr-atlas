import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  createManualCapture,
  OutboxStore,
  runConnector,
  type ManualCaptureInput,
} from '@pr-lore/core'
import { createBuiltinRegistry } from './runtime/registry.js'
import { ConfigStore, asJsonObject } from './runtime/config.js'
import {
  hasFlag,
  option,
  options,
  parseArgs,
  requiredOption,
  type ParsedArgs,
} from './inputs/args.js'
import {
  assertValidCapture,
  hashText,
  type CaptureTrigger,
  type ConnectorInstance,
  type SubjectKind,
} from '@pr-lore/schema'

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  const registry = createBuiltinRegistry()

  try {
    switch (command ?? 'help') {
      case 'capture':
        await captureCommand(args)
        break
      case 'save':
        await saveCommand(args)
        break
      case 'connector':
        await connectorCommand(args, registry)
        break
      case 'status':
        await statusCommand(args, registry)
        break
      case 'retry':
        await retryCommand(args)
        break
      case 'config':
        await configCommand(args, registry)
        break
      case 'help':
      case '--help':
      case '-h':
        printHelp()
        break
      default:
        throw new Error(`Unknown command: ${command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`lore: ${message}`)
    process.exitCode = 1
  }
}

async function captureCommand(args: ParsedArgs): Promise<void> {
  const url = option(args, 'url')
  const text = option(args, 'text')
  if (Boolean(url) === Boolean(text)) {
    throw new Error('capture requires exactly one of --url or --text')
  }

  const input: ManualCaptureInput = {
    uri: url ?? `text://manual/${hashText(text ?? '').slice('sha256:'.length)}`,
    text,
    title: option(args, 'title'),
    note: option(args, 'note'),
    tags: options(args, 'tag'),
  }
  const kind = option(args, 'kind')
  if (kind) input.kind = kind as SubjectKind
  const capture = createManualCapture(input)
  const outbox = new OutboxStore(dataDirectory(args))
  const entry = await outbox.enqueue(capture)
  emit({ capture, outbox: entry })
}

async function saveCommand(args: ParsedArgs): Promise<void> {
  const file = requiredOption(args, 'file')
  const raw = await readFile(resolve(file), 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const capture = assertValidCapture(unwrapCapture(parsed))
  const entry = await new OutboxStore(dataDirectory(args)).enqueue(capture)
  emit({ capture, outbox: entry })
}

async function connectorCommand(args: ParsedArgs, registry: ReturnType<typeof createBuiltinRegistry>): Promise<void> {
  const action = args.positionals[0] ?? 'list'
  if (action === 'list') {
    emit(registry.list().map(connector => connector.manifest()))
    return
  }
  if (action !== 'run') throw new Error(`Unknown connector action: ${action}`)

  const connectorId = args.positionals[1] ?? requiredOption(args, 'connector')
  const connector = registry.get(connectorId)
  const dataDir = dataDirectory(args)
  const configStore = new ConfigStore(dataDir)
  const configuredId = option(args, 'instance')
  const configRaw = option(args, 'config')
  let instance: ConnectorInstance

  if (configRaw) {
    instance = {
      id: configuredId ?? `${connectorId}-default`,
      connector: connectorId,
      enabled: !hasFlag(args, 'disabled'),
      schedule: option(args, 'schedule'),
      config: asJsonObject(configRaw, '--config'),
      checkpoint: null,
    }
    if (hasFlag(args, 'save')) await configStore.upsert(instance)
  } else {
    if (!configuredId) throw new Error('connector run requires --config or --instance')
    const configured = await configStore.get(configuredId)
    if (!configured) throw new Error(`Unknown connector instance: ${configuredId}`)
    if (configured.connector !== connectorId) {
      throw new Error(`Instance ${configuredId} belongs to ${configured.connector}, not ${connectorId}`)
    }
    instance = configured
  }

  const trigger = parseTrigger(option(args, 'trigger') ?? 'manual')
  const result = await runConnector(registry, instance, trigger)
  const outbox = new OutboxStore(dataDir)
  for (const capture of result.captures) await outbox.enqueue(capture)

  if (configuredId && !configRaw) {
    await configStore.upsert({ ...instance, checkpoint: result.checkpoint })
  }
  emit({
    connector: connector.manifest(),
    instance_id: instance.id,
    captures: result.captures,
    checkpoint: result.checkpoint,
    enqueued: result.captures.length,
  })
}

async function statusCommand(args: ParsedArgs, registry: ReturnType<typeof createBuiltinRegistry>): Promise<void> {
  const dataDir = dataDirectory(args)
  const [summary, config] = await Promise.all([
    new OutboxStore(dataDir).summary(),
    new ConfigStore(dataDir).load(),
  ])
  emit({
    data_dir: dataDir,
    outbox: summary,
    instances: config.instances,
    connectors: registry.list().map(item => item.manifest()),
  })
}

async function retryCommand(args: ParsedArgs): Promise<void> {
  const outbox = new OutboxStore(dataDirectory(args))
  const id = option(args, 'id')
  const failed = await outbox.list('failed')
  const selected = id ? failed.filter(entry => entry.capture.id === id) : failed
  const retried = []
  for (const entry of selected) retried.push(await outbox.mark(entry.capture.id, 'pending', null))
  emit({ retried: retried.map(entry => entry.capture.id), count: retried.length })
}

async function configCommand(args: ParsedArgs, registry: ReturnType<typeof createBuiltinRegistry>): Promise<void> {
  const action = args.positionals[0] ?? 'list'
  const store = new ConfigStore(dataDirectory(args))
  if (action === 'list') {
    emit((await store.load()).instances)
    return
  }
  const id = args.positionals[1] ?? option(args, 'instance')
  if (!id) throw new Error(`config ${action} requires an instance id`)

  if (action === 'get') {
    const instance = await store.get(id)
    if (!instance) throw new Error(`Unknown connector instance: ${id}`)
    emit(instance)
    return
  }
  if (action === 'remove') {
    emit({ id, removed: await store.remove(id) })
    return
  }
  if (action !== 'set') throw new Error(`Unknown config action: ${action}`)

  const connectorId = requiredOption(args, 'connector')
  const connector = registry.get(connectorId)
  const existing = await store.get(id)
  const instance: ConnectorInstance = {
    id,
    connector: connector.manifest().id,
    enabled: !hasFlag(args, 'disabled'),
    schedule: option(args, 'schedule') ?? existing?.schedule ?? connector.manifest().default_schedule,
    config: asJsonObject(requiredOption(args, 'config'), '--config'),
    checkpoint: existing?.checkpoint ?? null,
  }
  await store.upsert(instance)
  emit(instance)
}

function dataDirectory(args: ParsedArgs): string {
  return resolve(option(args, 'data-dir') ?? process.env.LORE_DATA_DIR ?? '.lore')
}

function parseTrigger(value: string): CaptureTrigger {
  if (value === 'manual' || value === 'schedule' || value === 'webhook' || value === 'import') return value
  throw new Error(`Invalid trigger: ${value}`)
}

function unwrapCapture(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'capture' in value) {
    return (value as { capture: unknown }).capture
  }
  return value
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printHelp(): void {
  process.stdout.write(`lore - connector-driven personal memory collection

Commands:
  lore capture --url <url> [--title <title>] [--note <note>] [--tag <tag>]
  lore capture --text <text> [--title <title>] [--note <note>]
  lore save --file <capture.json>
  lore connector list
  lore connector run <id> --instance <instance> [--trigger schedule]
  lore connector run <id> --config '<json>' [--save]
  lore config list|get|set|remove
  lore status
  lore retry [--id <capture-id>]

Global option:
  --data-dir <path>   Store config and outbox under this directory (default ./.lore)

priority-me-blog example:
  lore config set priority --connector priority-me-blog \\
    --config '{"repository_url":"https://github.com/priority3/priority.me","site_url":"https://razet.me"}'
  lore connector run priority-me-blog --instance priority
`)
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entryUrl === import.meta.url) void main()
