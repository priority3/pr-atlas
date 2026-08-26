import { DELIVERER_KINDS, DELIVERER_SCHEMAS, isDelivererKind } from '@pr-lore/core'
import { validateJsonSchema } from '@pr-lore/schema'
import { option, requiredOption, type ParsedArgs } from '../inputs/args.js'
import { ConfigStore, asJsonObject, type DeliveryTarget } from '../runtime/config.js'
import { dataDirectory, emit } from '../runtime/io.js'

export async function targetCommand(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? 'list'
  const store = new ConfigStore(dataDirectory(args))

  if (action === 'list') {
    emit((await store.load()).targets)
    return
  }
  if (action === 'kinds') {
    emit(DELIVERER_KINDS.map(kind => ({ kind, config_schema: DELIVERER_SCHEMAS[kind] })))
    return
  }

  const id = args.positionals[1] ?? option(args, 'target')
  if (!id) throw new Error(`target ${action} requires a target id`)

  if (action === 'get') {
    const target = await store.getTarget(id)
    if (!target) throw new Error(`Unknown delivery target: ${id}`)
    emit(target)
    return
  }
  if (action === 'remove') {
    emit({ id, removed: await store.removeTarget(id) })
    return
  }
  if (action !== 'set') throw new Error(`Unknown target action: ${action}`)

  const kind = requiredOption(args, 'kind')
  if (!isDelivererKind(kind)) {
    throw new Error(`Unknown target kind: ${kind}. Supported kinds are ${DELIVERER_KINDS.join(', ')}`)
  }

  const config = asJsonObject(requiredOption(args, 'config'), '--config')
  const errors = validateJsonSchema(DELIVERER_SCHEMAS[kind], config)
  if (errors.length > 0) {
    throw new Error(`Invalid config for ${kind} target ${id}:\n  - ${errors.join('\n  - ')}`)
  }

  const target: DeliveryTarget = { id, kind, config }
  await store.upsertTarget(target)
  emit(target)
}
