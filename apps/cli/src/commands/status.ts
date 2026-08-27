import { OutboxStore, type ConnectorRegistry } from '@pr-atlas/core'
import { option, type ParsedArgs } from '../inputs/args.js'
import { ConfigStore } from '../runtime/config.js'
import { dataDirectory, emit } from '../runtime/io.js'

export async function statusCommand(args: ParsedArgs, registry: ConnectorRegistry): Promise<void> {
  const dataDir = dataDirectory(args)
  const [summary, config] = await Promise.all([
    new OutboxStore(dataDir).summary(),
    new ConfigStore(dataDir).load(),
  ])
  emit({
    data_dir: dataDir,
    outbox: summary,
    instances: config.instances,
    targets: config.targets,
    connectors: registry.list().map(connector => connector.manifest().id),
  })
}

export async function retryCommand(args: ParsedArgs): Promise<void> {
  const outbox = new OutboxStore(dataDirectory(args))
  const id = option(args, 'id')
  const failed = await outbox.list('failed')
  const selected = id ? failed.filter(entry => entry.capture.id === id) : failed

  const retried: string[] = []
  for (const entry of selected) {
    await outbox.mark(entry.capture.id, 'pending', null)
    retried.push(entry.capture.id)
  }
  emit({ retried, count: retried.length, outbox: await outbox.summary() })
}
