import { randomUUID } from 'node:crypto'
import {
  assertValidCapture,
  validateJsonSchema,
  type CaptureTrigger,
  type ConnectorContext,
  type ConnectorInstance,
  type ConnectorResult,
  type LoreConnector,
} from '@pr-lore/schema'

export class ConnectorRegistry {
  private readonly connectors = new Map<string, LoreConnector>()

  register(connector: LoreConnector): void {
    const id = connector.manifest().id
    if (this.connectors.has(id)) throw new Error(`Connector already registered: ${id}`)
    this.connectors.set(id, connector)
  }

  get(id: string): LoreConnector {
    const connector = this.connectors.get(id)
    if (!connector) throw new Error(`Unknown connector: ${id}`)
    return connector
  }

  list(): LoreConnector[] {
    return [...this.connectors.values()].sort((a, b) =>
      a.manifest().id.localeCompare(b.manifest().id),
    )
  }
}

export interface RunConnectorOptions {
  trigger?: CaptureTrigger
  /**
   * Discard the stored checkpoint for this run so the connector re-collects
   * everything. Connectors need no special handling: they simply observe a
   * `null` checkpoint.
   */
  full?: boolean
  now?: string
}

export async function runConnector(
  registry: ConnectorRegistry,
  instance: ConnectorInstance,
  options: RunConnectorOptions = {},
): Promise<ConnectorResult> {
  const trigger = options.trigger ?? 'manual'
  const connector = registry.get(instance.connector)
  const manifest = connector.manifest()
  if (!instance.enabled && trigger !== 'manual') {
    throw new Error(`Connector instance is disabled: ${instance.id}`)
  }

  // Reason: this is the single enforcement point for connector config. A future
  // daemon or webhook entry point runs through here too, so validating in the
  // CLI alone would leave those paths unchecked.
  const errors = validateJsonSchema(manifest.config_schema, instance.config)
  if (errors.length > 0) {
    throw new Error(
      `Invalid config for connector ${manifest.id} (instance ${instance.id}):\n  - ${errors.join('\n  - ')}`,
    )
  }

  const context: ConnectorContext = {
    instance: options.full ? { ...instance, checkpoint: null } : instance,
    run_id: `run_${randomUUID()}`,
    trigger,
    now: options.now ?? new Date().toISOString(),
  }
  const result = await connector.collect(context)
  for (const capture of result.captures) assertValidCapture(capture)
  return result
}
