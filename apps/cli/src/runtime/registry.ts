import { createGenericWebConnector, createPriorityMeBlogConnector } from '@pr-atlas/connectors'
import { ConnectorRegistry } from '@pr-atlas/core'

export function createBuiltinRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  registry.register(createGenericWebConnector())
  registry.register(createPriorityMeBlogConnector())
  return registry
}
