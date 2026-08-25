import { createGenericWebConnector, createPriorityMeBlogConnector } from '@pr-lore/connectors'
import { ConnectorRegistry } from '@pr-lore/core'

export function createBuiltinRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  registry.register(createGenericWebConnector())
  registry.register(createPriorityMeBlogConnector())
  return registry
}
