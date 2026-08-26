export interface ParsedArgs {
  positionals: string[]
  options: Map<string, string[]>
  flags: Set<string>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string[]>()
  const flags = new Set<string>()
  let parseOptions = true
  // Reason: these never take a value, so a following bare word is a positional
  // rather than this option's argument (`--full priority-me-blog`).
  const booleanOptions = new Set(['disabled', 'help', 'save', 'full'])

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value) continue
    if (parseOptions && value === '--') {
      parseOptions = false
      continue
    }
    if (!parseOptions || !value.startsWith('--')) {
      positionals.push(value)
      continue
    }

    const raw = value.slice(2)
    const equals = raw.indexOf('=')
    if (equals >= 0) {
      addOption(options, raw.slice(0, equals), raw.slice(equals + 1))
      continue
    }

    const next = argv[index + 1]
    if (next && !next.startsWith('--') && !booleanOptions.has(raw)) {
      addOption(options, raw, next)
      index += 1
    } else {
      flags.add(raw)
    }
  }

  return { positionals, options, flags }
}

export function option(args: ParsedArgs, name: string): string | null {
  const values = args.options.get(name)
  return values?.at(-1) ?? null
}

export function options(args: ParsedArgs, name: string): string[] {
  return args.options.get(name) ?? []
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name)
}

export function requiredOption(args: ParsedArgs, name: string): string {
  const value = option(args, name)
  if (!value?.trim()) throw new Error(`Missing required option --${name}`)
  return value.trim()
}

function addOption(options: Map<string, string[]>, name: string, value: string): void {
  const values = options.get(name) ?? []
  values.push(value)
  options.set(name, values)
}
