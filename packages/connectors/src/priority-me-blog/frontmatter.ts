import type { JsonValue } from '@pr-lore/schema'

/**
 * A YAML subset parser for Markdown frontmatter.
 *
 * Supported:
 *   - `key: value` scalars, including quoted strings, booleans, numbers, `null`/`~`
 *   - inline flow collections: `[a, b]` and `{a: 1, b: 2}`
 *   - block sequences (`- item`), including sequences of mappings
 *   - nested mappings at arbitrary depth
 *   - block scalars `|` and `>` (with optional chomping indicator)
 *   - `#` comments, which are literal text inside block scalars
 *
 * Explicitly rejected with an error: tab indentation, anchors and aliases
 * (`&x` / `*x`), merge keys (`<<:`), complex keys (`? `), and multiple
 * documents. Refusing these is the point — the previous implementation dropped
 * anything it did not understand, so a mis-indented `tags:` list silently
 * became no tags at all.
 *
 * Dates are intentionally left as strings: `LoreCapture` metadata is JSON.
 */
export interface Frontmatter {
  data: Record<string, JsonValue>
  body: string
}

interface Line {
  number: number
  indent: number
  /** Full line, used verbatim by block scalars. */
  raw: string
  /** Comment-stripped and trimmed. */
  content: string
  blank: boolean
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/

export function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(FRONTMATTER)
  if (!match) return { data: {}, body: raw.trim() }
  return { data: parseDocument(match[1] ?? ''), body: (match[2] ?? '').trim() }
}

function parseDocument(block: string): Record<string, JsonValue> {
  const lines = toLines(block)
  const first = nextMeaningful(lines, 0)
  if (!first) return {}
  if (first.line.content.startsWith('-')) {
    throw new Error(`frontmatter line ${first.line.number}: the document must be a mapping, not a sequence`)
  }

  const { value, next } = parseMapping(lines, first.index, first.line.indent)
  const trailing = nextMeaningful(lines, next)
  if (trailing) {
    throw new Error(`frontmatter line ${trailing.line.number}: unexpected content after the mapping`)
  }
  return value
}

function toLines(block: string): Line[] {
  return block.split(/\r?\n/).map((raw, offset) => {
    const number = offset + 1
    const leading = raw.match(/^[ \t]*/)?.[0] ?? ''
    if (leading.includes('\t')) {
      throw new Error(`frontmatter line ${number}: tab indentation is not supported, use spaces`)
    }
    const content = stripComment(raw).trim()
    return { number, indent: leading.length, raw, content, blank: content === '' }
  })
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): { value: Record<string, JsonValue>; next: number } {
  const value: Record<string, JsonValue> = {}
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (!line) break
    if (line.blank) {
      index += 1
      continue
    }
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new Error(`frontmatter line ${line.number}: unexpected indentation`)
    }

    rejectUnsupported(line)
    const { key, rest } = splitKey(line)

    if (/^[|>][+-]?$/.test(rest)) {
      const scalar = collectBlockScalar(lines, index + 1, indent, rest.startsWith('|'))
      value[key] = scalar.value
      index = scalar.next
      continue
    }

    if (rest !== '') {
      value[key] = parseScalar(rest, line.number)
      index += 1
      continue
    }

    const child = nextMeaningful(lines, index + 1)
    if (child) {
      // A block sequence may sit at its key's own indent, which is valid YAML:
      //   tags:
      //   - tech
      const sequenceAtKeyIndent = child.line.indent === indent && child.line.content.startsWith('-')
      if (child.line.indent > indent || sequenceAtKeyIndent) {
        const nested = child.line.content.startsWith('-')
          ? parseSequence(lines, child.index, child.line.indent)
          : parseMapping(lines, child.index, child.line.indent)
        value[key] = nested.value
        index = nested.next
        continue
      }
    }

    value[key] = null
    index += 1
  }

  return { value, next: index }
}

function parseSequence(lines: Line[], start: number, indent: number): { value: JsonValue[]; next: number } {
  const value: JsonValue[] = []
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (!line) break
    if (line.blank) {
      index += 1
      continue
    }
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new Error(`frontmatter line ${line.number}: unexpected indentation`)
    }
    if (!line.content.startsWith('-')) break

    rejectUnsupported(line)
    const rest = line.content.slice(1).trim()

    if (rest === '') {
      const child = nextMeaningful(lines, index + 1)
      if (!child || child.line.indent <= indent) {
        value.push(null)
        index += 1
        continue
      }
      const nested = child.line.content.startsWith('-')
        ? parseSequence(lines, child.index, child.line.indent)
        : parseMapping(lines, child.index, child.line.indent)
      value.push(nested.value)
      index = nested.next
      continue
    }

    // `- key: value` starts a mapping whose remaining keys align under the dash.
    // Reason: re-parsing it as a mapping at a synthetic indent keeps one code
    // path for mappings instead of a second, subtly different one.
    if (!rest.startsWith('[') && !rest.startsWith('{') && findKeySeparator(rest) >= 0) {
      const virtualIndent = line.indent + 2
      const synthetic: Line = {
        number: line.number,
        indent: virtualIndent,
        raw: `${' '.repeat(virtualIndent)}${rest}`,
        content: rest,
        blank: false,
      }
      const nested = parseMapping([synthetic, ...lines.slice(index + 1)], 0, virtualIndent)
      value.push(nested.value)
      index += nested.next
      continue
    }

    value.push(parseScalar(rest, line.number))
    index += 1
  }

  return { value, next: index }
}

function collectBlockScalar(
  lines: Line[],
  start: number,
  parentIndent: number,
  literal: boolean,
): { value: string; next: number } {
  const collected: string[] = []
  let index = start
  let blockIndent: number | null = null

  while (index < lines.length) {
    const line = lines[index]
    if (!line) break

    // Reason: inside a block scalar a blank line is content and a `#` is a
    // literal character, so `raw` is used and `content` ignored.
    if (line.raw.trim() === '') {
      collected.push('')
      index += 1
      continue
    }
    const lineIndent = line.raw.match(/^ */)?.[0].length ?? 0
    if (lineIndent <= parentIndent) break

    blockIndent ??= lineIndent
    collected.push(line.raw.slice(blockIndent))
    index += 1
  }

  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  return { value: literal ? collected.join('\n') : foldLines(collected), next: index }
}

function foldLines(lines: string[]): string {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) paragraphs.push(current.join(' '))
      current = []
      continue
    }
    current.push(line.trim())
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs.join('\n')
}

function parseScalar(value: string, lineNumber: number): JsonValue {
  const text = value.trim()
  if (text === '' || text === 'null' || text === 'Null' || text === '~') return null
  if (text.startsWith('&') || text.startsWith('*')) {
    throw new Error(`frontmatter line ${lineNumber}: YAML anchors and aliases are not supported`)
  }
  if (text.startsWith('[')) return parseFlowSequence(text, lineNumber)
  if (text.startsWith('{')) return parseFlowMapping(text, lineNumber)
  if (isQuoted(text)) return unquote(text)
  if (text === 'true' || text === 'True') return true
  if (text === 'false' || text === 'False') return false
  if (/^-?\d+$/.test(text) || /^-?\d+\.\d+$/.test(text)) return Number(text)
  return text
}

function parseFlowSequence(text: string, lineNumber: number): JsonValue[] {
  if (!text.endsWith(']')) {
    throw new Error(`frontmatter line ${lineNumber}: unterminated inline sequence`)
  }
  return splitFlow(text.slice(1, -1)).map(item => parseScalar(item, lineNumber))
}

function parseFlowMapping(text: string, lineNumber: number): Record<string, JsonValue> {
  if (!text.endsWith('}')) {
    throw new Error(`frontmatter line ${lineNumber}: unterminated inline mapping`)
  }
  const value: Record<string, JsonValue> = {}
  for (const pair of splitFlow(text.slice(1, -1))) {
    const separator = findKeySeparator(pair)
    if (separator < 0) {
      throw new Error(`frontmatter line ${lineNumber}: inline mapping entry "${pair}" is missing a value`)
    }
    const rawKey = pair.slice(0, separator).trim()
    value[isQuoted(rawKey) ? unquote(rawKey) : rawKey] = parseScalar(pair.slice(separator + 1), lineNumber)
  }
  return value
}

/** Splits on top-level commas, ignoring separators inside quotes or nested flow collections. */
function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let quote: string | null = null

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (quote) {
      current += char
      if (char === '\\' && quote === '"') {
        current += inner[index + 1] ?? ''
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)

  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** Index of the `:` that separates a key from its value, or -1. */
function findKeySeparator(text: string): number {
  let depth = 0
  let quote: string | null = null

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ':' && depth === 0) {
      const next = text[index + 1]
      if (next === undefined || next === ' ' || next === '\t') return index
    }
  }
  return -1
}

function splitKey(line: Line): { key: string; rest: string } {
  const separator = findKeySeparator(line.content)
  if (separator < 0) {
    throw new Error(`frontmatter line ${line.number}: expected "key: value", found "${line.content}"`)
  }
  const rawKey = line.content.slice(0, separator).trim()
  const key = isQuoted(rawKey) ? unquote(rawKey) : rawKey
  if (!key) throw new Error(`frontmatter line ${line.number}: empty mapping key`)
  return { key, rest: line.content.slice(separator + 1).trim() }
}

function rejectUnsupported(line: Line): void {
  const content = line.content
  if (content === '---' || content === '...') {
    throw new Error(`frontmatter line ${line.number}: multiple YAML documents are not supported`)
  }
  if (content.startsWith('<<:')) {
    throw new Error(`frontmatter line ${line.number}: YAML merge keys are not supported`)
  }
  if (content.startsWith('? ')) {
    throw new Error(`frontmatter line ${line.number}: complex mapping keys are not supported`)
  }
}

function stripComment(value: string): string {
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    // A `#` opens a comment only at the start of a line or after whitespace,
    // so `https://x/#anchor` stays intact.
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return value.slice(0, index)
    }
  }
  return value
}

function isQuoted(text: string): boolean {
  if (text.length < 2) return false
  const first = text[0]
  return (first === '"' || first === "'") && text.endsWith(first)
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  r: '\r',
  t: '\t',
}

function unquote(text: string): string {
  const inner = text.slice(1, -1)
  if (text.startsWith("'")) return inner.replace(/''/g, "'")
  return inner.replace(/\\(.)/g, (_, char: string) => ESCAPES[char] ?? char)
}

function nextMeaningful(lines: Line[], start: number): { line: Line; index: number } | null {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (line && !line.blank) return { line, index }
  }
  return null
}
