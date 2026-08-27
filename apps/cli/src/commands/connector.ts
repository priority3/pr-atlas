import { OutboxStore, runConnector, type ConnectorRegistry } from '@pr-atlas/core'
import type { CaptureTrigger, ConnectorInstance } from '@pr-atlas/schema'
import { hasFlag, option, requiredOption, type ParsedArgs } from '../inputs/args.js'
import { ConfigStore, asJsonObject } from '../runtime/config.js'
import { dataDirectory, emit } from '../runtime/io.js'

export async function connectorCommand(args: ParsedArgs, registry: ConnectorRegistry): Promise<void> {
  const action = args.positionals[0] ?? 'list'
  if (action === 'list') {
    emit(registry.list().map(connector => connector.manifest()))
    return
  }
  if (action !== 'run') throw new Error(`Unknown connector action: ${action}`)

  const connectorId = args.positionals[1] ?? requiredOption(args, 'connector')
  registry.get(connectorId)

  const dataDir = dataDirectory(args)
  const configStore = new ConfigStore(dataDir)
  const configuredId = option(args, 'instance')
  const configRaw = option(args, 'config')

  let instance: ConnectorInstance
  let persistCheckpoint = false

  if (configRaw) {
    instance = {
      id: configuredId ?? `${connectorId}-default`,
      connector: connectorId,
      enabled: !hasFlag(args, 'disabled'),
      schedule: option(args, 'schedule'),
      config: asJsonObject(configRaw, '--config'),
      checkpoint: null,
    }
    if (hasFlag(args, 'save')) {
      await configStore.upsert(instance)
      persistCheckpoint = true
    }
  } else {
    if (!configuredId) throw new Error('connector run requires --config or --instance')
    const configured = await configStore.get(configuredId)
    if (!configured) throw new Error(`Unknown connector instance: ${configuredId}`)
    if (configured.connector !== connectorId) {
      throw new Error(
        `Instance ${configuredId} belongs to ${configured.connector}, not ${connectorId}`,
      )
    }
    instance = configured
    persistCheckpoint = true
  }

  const trigger = parseTrigger(option(args, 'trigger') ?? 'manual')
  const full = hasFlag(args, 'full')
  const result = await runConnector(registry, instance, { trigger, full })

  const outbox = new OutboxStore(dataDir)
  // Reason: enqueue is idempotent, so the honest "enqueued" number is the change
  // in outbox size rather than the number of captures handed to it.
  const before = await outbox.summary()
  for (const capture of result.captures) await outbox.enqueue(capture)
  const after = await outbox.summary()

  if (persistCheckpoint) {
    await configStore.upsert({ ...instance, checkpoint: result.checkpoint })
  }

  emit({
    connector: connectorId,
    instance_id: instance.id,
    trigger,
    full,
    collected: result.captures.length,
    enqueued: after.total - before.total,
    captures: result.captures,
    checkpoint: result.checkpoint,
  })
}

function parseTrigger(value: string): CaptureTrigger {
  if (value === 'manual' || value === 'schedule' || value === 'webhook' || value === 'import') {
    return value
  }
  throw new Error(`Invalid trigger: ${value}`)
}
