import type { ConnectorRegistry } from '@pr-lore/core'
import { validateJsonSchema, type ConnectorInstance } from '@pr-lore/schema'
import { hasFlag, option, requiredOption, type ParsedArgs } from '../inputs/args.js'
import { ConfigStore, asJsonObject } from '../runtime/config.js'
import { dataDirectory, emit } from '../runtime/io.js'

export async function configCommand(args: ParsedArgs, registry: ConnectorRegistry): Promise<void> {
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

  const connector = registry.get(requiredOption(args, 'connector'))
  const manifest = connector.manifest()
  const config = asJsonObject(requiredOption(args, 'config'), '--config')

  // Reason: `runConnector` validates too, but reporting here means a typo fails
  // when it is written rather than at 03:00 on the next scheduled run.
  const errors = validateJsonSchema(manifest.config_schema, config)
  if (errors.length > 0) {
    throw new Error(`Invalid config for connector ${manifest.id}:\n  - ${errors.join('\n  - ')}`)
  }

  const existing = await store.get(id)
  const instance: ConnectorInstance = {
    id,
    connector: manifest.id,
    enabled: !hasFlag(args, 'disabled'),
    schedule: option(args, 'schedule') ?? existing?.schedule ?? manifest.default_schedule,
    config,
    checkpoint: existing?.checkpoint ?? null,
  }
  await store.upsert(instance)
  emit(instance)
}
