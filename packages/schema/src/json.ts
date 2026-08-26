/**
 * JSON value primitives shared by capture payloads, connector config and
 * manifest schemas. Kept in its own module so `json-schema.ts` can depend on
 * the types without importing back through the package barrel.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

/** True for `{}`-shaped values only: arrays and null are excluded. */
export function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
