import { resolve } from 'node:path'
import { option, type ParsedArgs } from '../inputs/args.js'

export function dataDirectory(args: ParsedArgs): string {
  return resolve(option(args, 'data-dir') ?? process.env.ATLAS_DATA_DIR ?? '.atlas')
}

export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
