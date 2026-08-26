import { OutboxStore, createDeliverer, syncOutbox, type SyncOptions } from '@pr-lore/core'
import { option, options, type ParsedArgs } from '../inputs/args.js'
import { ConfigStore, type DeliveryTarget } from '../runtime/config.js'
import { dataDirectory, emit } from '../runtime/io.js'

export async function syncCommand(args: ParsedArgs): Promise<void> {
  const dataDir = dataDirectory(args)
  const target = await resolveTarget(new ConfigStore(dataDir), option(args, 'target'))
  const deliverer = createDeliverer(target.kind, target.config, target.id)

  const syncOptions: SyncOptions = {}
  const limit = option(args, 'limit')
  if (limit !== null) {
    const parsed = Number(limit)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('--limit must be a positive integer')
    }
    syncOptions.limit = parsed
  }
  const ids = options(args, 'id')
  if (ids.length > 0) syncOptions.ids = ids

  const outbox = new OutboxStore(dataDir)
  const summary = await syncOutbox(outbox, deliverer, syncOptions)
  emit({ ...summary, kind: target.kind, outbox: await outbox.summary() })
}

async function resolveTarget(store: ConfigStore, id: string | null): Promise<DeliveryTarget> {
  const { targets } = await store.load()

  if (id) {
    const found = targets.find(target => target.id === id)
    if (!found) throw new Error(`Unknown delivery target: ${id}`)
    return found
  }

  const [only] = targets
  if (!only) {
    throw new Error(
      'No delivery target configured. Add one with:\n' +
        '  lore target set local --kind file --config \'{"directory":"./lore-export"}\'',
    )
  }
  if (targets.length > 1) {
    throw new Error(
      `Multiple delivery targets configured; pass --target <${targets.map(target => target.id).join('|')}>`,
    )
  }
  return only
}
