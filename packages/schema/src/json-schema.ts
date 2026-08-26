import { isPlainObject, type JsonValue } from './json.js'

/**
 * A deliberately small JSON Schema subset, sized to what connector manifests
 * actually declare.
 *
 * Supported keywords: `type` (single or union), `required`, `properties`,
 * `additionalProperties: false`, `items`, `enum`, `format: "uri"`,
 * `minLength`, `minItems`.
 *
 * Every other keyword is ignored on purpose. Manifests carry documentation-only
 * fields such as `description` and `default`, and ignoring unknown keywords
 * keeps older manifests valid against newer validators.
 *
 * Returns a list of human-readable errors rather than throwing, so callers can
 * decide whether to report all problems at once (CLI) or fail fast (runtime).
 */
export function validateJsonSchema(schema: JsonValue, value: unknown, path = ''): string[] {
  if (!isPlainObject(schema)) return []
  const label = path || 'config'

  // Reason: enum and type failures make every downstream keyword meaningless,
  // so we stop early instead of emitting a cascade of derived errors.
  const allowed = schema.enum
  if (Array.isArray(allowed) && !allowed.some(candidate => jsonEquals(candidate, value))) {
    return [`${label} must be one of ${allowed.map(item => JSON.stringify(item)).join(', ')}`]
  }

  const types = normalizeTypes(schema.type)
  if (types.length > 0 && !types.some(type => matchesType(type, value))) {
    return [`${label} must be ${types.join(' or ')}, received ${describeType(value)}`]
  }

  const errors: string[] = []
  if (isPlainObject(value)) errors.push(...validateObject(schema, value, path))
  if (Array.isArray(value)) errors.push(...validateArray(schema, value, path))
  if (typeof value === 'string') errors.push(...validateString(schema, value, label))
  return errors
}

function validateObject(
  schema: Record<string, JsonValue>,
  value: Record<string, JsonValue>,
  path: string,
): string[] {
  const errors: string[] = []
  const properties = isPlainObject(schema.properties) ? schema.properties : {}

  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && value[key] === undefined) {
        errors.push(`${childLabel(path, key)} is required`)
      }
    }
  }

  if (schema.additionalProperties === false) {
    const known = Object.keys(properties)
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue
      errors.push(`${childLabel(path, key)} is not a recognized option${suggestion(key, known)}`)
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    const child = value[key]
    if (child === undefined || propertySchema === undefined) continue
    errors.push(...validateJsonSchema(propertySchema, child, childPath(path, key)))
  }
  return errors
}

function validateArray(schema: Record<string, JsonValue>, value: JsonValue[], path: string): string[] {
  const errors: string[] = []
  const minItems = schema.minItems
  if (typeof minItems === 'number' && value.length < minItems) {
    errors.push(`${path || 'config'} must contain at least ${minItems} item(s)`)
  }

  const items = schema.items
  if (items !== undefined) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(items, item, `${path || 'config'}[${index}]`))
    })
  }
  return errors
}

function validateString(schema: Record<string, JsonValue>, value: string, label: string): string[] {
  const errors: string[] = []
  const minLength = schema.minLength
  if (typeof minLength === 'number' && value.length < minLength) {
    errors.push(`${label} must be at least ${minLength} character(s)`)
  }
  if (schema.format === 'uri' && !isUri(value)) {
    errors.push(`${label} must be a valid absolute URI`)
  }
  return errors
}

function normalizeTypes(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      // Reason: an unrecognized type name must not silently reject valid config.
      return true
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value === undefined) return 'nothing'
  return typeof value
}

function jsonEquals(a: JsonValue, b: unknown): boolean {
  if (a === null || typeof a !== 'object') return Object.is(a, b)
  return JSON.stringify(a) === JSON.stringify(b)
}

function isUri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol)
  } catch {
    return false
  }
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function childLabel(path: string, key: string): string {
  return `config.${childPath(path, key)}`
}

/**
 * Offers a "did you mean" hint for misspelled option names, which is the most
 * common config mistake once `additionalProperties: false` is enforced.
 */
function suggestion(key: string, known: string[]): string {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of known) {
    const distance = editDistance(key, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  const threshold = Math.max(2, Math.floor(key.length / 3))
  return best && bestDistance <= threshold ? ` (did you mean "${best}"?)` : ''
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      current.push(Math.min(substitution, deletion, insertion))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}
