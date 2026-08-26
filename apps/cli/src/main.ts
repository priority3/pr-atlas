#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from './inputs/args.js'
import { captureCommand, saveCommand } from './commands/capture.js'
import { configCommand } from './commands/config.js'
import { connectorCommand } from './commands/connector.js'
import { retryCommand, statusCommand } from './commands/status.js'
import { syncCommand } from './commands/sync.js'
import { targetCommand } from './commands/target.js'
import { createBuiltinRegistry } from './runtime/registry.js'

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  const registry = createBuiltinRegistry()

  try {
    switch (command ?? 'help') {
      case 'capture':
        await captureCommand(args)
        break
      case 'save':
        await saveCommand(args)
        break
      case 'connector':
        await connectorCommand(args, registry)
        break
      case 'config':
        await configCommand(args, registry)
        break
      case 'target':
        await targetCommand(args)
        break
      case 'sync':
        await syncCommand(args)
        break
      case 'status':
        await statusCommand(args, registry)
        break
      case 'retry':
        await retryCommand(args)
        break
      case 'help':
      case '--help':
      case '-h':
        printHelp()
        break
      default:
        throw new Error(`Unknown command: ${command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`lore: ${message}`)
    process.exitCode = 1
  }
}

function printHelp(): void {
  process.stdout.write(`lore - connector-driven personal memory collection

Capture:
  lore capture --url <url> [--title <title>] [--note <note>] [--tag <tag>]
  lore capture --text <text> [--title <title>] [--note <note>]
  lore save --file <capture.json>

Connectors:
  lore connector list
  lore connector run <id> --instance <instance> [--trigger schedule] [--full]
  lore connector run <id> --config '<json>' [--save]
  lore config list | get <id> | set <id> --connector <id> --config '<json>' | remove <id>

Delivery:
  lore target kinds
  lore target list | get <id> | set <id> --kind <file|webhook> --config '<json>' | remove <id>
  lore sync [--target <id>] [--limit <n>] [--id <capture-id>]

Inspect:
  lore status
  lore retry [--id <capture-id>]

Global option:
  --data-dir <path>   Store config and outbox under this directory (default ./.lore)

Notes:
  Runs are incremental: a connector whose source is unchanged collects nothing.
  Use --full to ignore the stored checkpoint and re-collect everything.
  Captures marked "sensitive" are not delivered to network targets unless the
  target sets include_privacy_levels explicitly.

priority-me-blog example:
  lore config set priority --connector priority-me-blog \\
    --config '{"repository_url":"https://github.com/priority3/priority.me","site_url":"https://razet.me"}'
  lore connector run priority-me-blog --instance priority
`)
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entryUrl === import.meta.url) void main()
