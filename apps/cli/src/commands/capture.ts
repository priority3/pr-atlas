import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { OutboxStore, createManualCapture, type ManualCaptureInput } from '@pr-lore/core'
import { assertValidCapture, hashText, type SubjectKind } from '@pr-lore/schema'
import { option, options, requiredOption, type ParsedArgs } from '../inputs/args.js'
import { dataDirectory, emit } from '../runtime/io.js'

export async function captureCommand(args: ParsedArgs): Promise<void> {
  const url = option(args, 'url')
  const text = option(args, 'text')
  if (Boolean(url) === Boolean(text)) {
    throw new Error('capture requires exactly one of --url or --text')
  }

  const input: ManualCaptureInput = {
    uri: url ?? `text://manual/${hashText(text ?? '').slice('sha256:'.length)}`,
    text,
    title: option(args, 'title'),
    note: option(args, 'note'),
    tags: options(args, 'tag'),
  }
  const kind = option(args, 'kind')
  if (kind) input.kind = kind as SubjectKind

  const capture = createManualCapture(input)
  const entry = await new OutboxStore(dataDirectory(args)).enqueue(capture)
  emit({ capture, outbox: entry })
}

export async function saveCommand(args: ParsedArgs): Promise<void> {
  const file = requiredOption(args, 'file')
  const raw = await readFile(resolve(file), 'utf8')
  const capture = assertValidCapture(unwrapCapture(JSON.parse(raw) as unknown))
  const entry = await new OutboxStore(dataDirectory(args)).enqueue(capture)
  emit({ capture, outbox: entry })
}

/** Accepts either a bare capture or the `{ capture, outbox }` shape the CLI prints. */
function unwrapCapture(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'capture' in value) {
    return (value as { capture: unknown }).capture
  }
  return value
}
