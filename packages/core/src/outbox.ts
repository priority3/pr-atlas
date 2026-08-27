import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertValidCapture, type AtlasCapture } from '@pr-atlas/schema'

export type OutboxStatus = 'pending' | 'sent' | 'failed'

export const OUTBOX_STATUSES: readonly OutboxStatus[] = ['pending', 'sent', 'failed']

export interface OutboxEntry {
  capture: AtlasCapture
  status: OutboxStatus
  attempts: number
  last_error: string | null
  updated_at: string
}

export interface OutboxSummary {
  total: number
  pending: number
  sent: number
  failed: number
}

/**
 * A file-backed outbox where an entry's status is its location:
 * `outbox/<status>/<capture-id>.json`.
 *
 * Keeping status in the path rather than only in the file body means counting
 * is a directory listing instead of a read of every entry, and a status change
 * is a single atomic rename with no second source of truth to fall out of sync.
 */
export class OutboxStore {
  private readonly directory: string
  private prepared: Promise<void> | null = null

  constructor(rootDirectory: string) {
    this.directory = join(rootDirectory, 'outbox')
  }

  async enqueue(capture: AtlasCapture): Promise<OutboxEntry> {
    assertValidCapture(capture)
    await this.prepare()

    // Reason: re-enqueuing an already delivered capture must not resurrect it
    // as pending, so an existing entry in any status wins.
    const existing = await this.locate(capture.id)
    if (existing) return this.readEntry(existing, capture.id)

    const entry: OutboxEntry = {
      capture,
      status: 'pending',
      attempts: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    }
    await this.writeAt(this.fileFor('pending', capture.id), entry)
    return entry
  }

  async list(status?: OutboxStatus): Promise<OutboxEntry[]> {
    await this.prepare()
    const targets = status ? [status] : OUTBOX_STATUSES
    const entries: OutboxEntry[] = []
    for (const target of targets) {
      for (const name of await this.namesIn(target)) {
        const raw = await readFile(join(this.directory, target, name), 'utf8')
        entries.push(JSON.parse(raw) as OutboxEntry)
      }
    }
    return entries
  }

  async summary(): Promise<OutboxSummary> {
    await this.prepare()
    const summary: OutboxSummary = { total: 0, pending: 0, sent: 0, failed: 0 }
    for (const status of OUTBOX_STATUSES) {
      const count = (await this.namesIn(status)).length
      summary[status] = count
      summary.total += count
    }
    return summary
  }

  async mark(
    id: string,
    status: OutboxStatus,
    error: string | null = null,
  ): Promise<OutboxEntry> {
    await this.prepare()
    const current = await this.locate(id)
    if (!current) throw new Error(`Unknown outbox entry: ${id}`)

    const source = this.fileFor(current, id)
    const entry = JSON.parse(await readFile(source, 'utf8')) as OutboxEntry
    const next: OutboxEntry = {
      ...entry,
      status,
      attempts: entry.attempts + (status === 'failed' ? 1 : 0),
      last_error: error,
      updated_at: new Date().toISOString(),
    }

    // Reason: update in place first, then move. The reverse order would leave
    // the entry visible under two statuses if the process died in between.
    await this.writeAt(source, next)
    if (current !== status) await rename(source, this.fileFor(status, id))
    return next
  }

  async remove(id: string): Promise<void> {
    await this.prepare()
    for (const status of OUTBOX_STATUSES) {
      await rm(this.fileFor(status, id), { force: true })
    }
  }

  private prepare(): Promise<void> {
    this.prepared ??= this.initialize()
    return this.prepared
  }

  private async initialize(): Promise<void> {
    for (const status of OUTBOX_STATUSES) {
      await mkdir(join(this.directory, status), { recursive: true })
    }
    await this.migrateFlatLayout()
  }

  /**
   * Earlier builds wrote every entry as `outbox/<id>.json` with the status only
   * in the file body. Those files are relocated once, on first access.
   */
  private async migrateFlatLayout(): Promise<void> {
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'))
    for (const name of names) {
      const source = join(this.directory, name)
      let status: OutboxStatus = 'pending'
      try {
        const entry = JSON.parse(await readFile(source, 'utf8')) as Partial<OutboxEntry>
        if (entry.status && OUTBOX_STATUSES.includes(entry.status)) status = entry.status
      } catch {
        // Reason: an unreadable legacy file should stay visible for inspection
        // rather than block the store or disappear, so it lands in pending.
      }
      await rename(source, join(this.directory, status, name))
    }
  }

  private async locate(id: string): Promise<OutboxStatus | null> {
    for (const status of OUTBOX_STATUSES) {
      try {
        await stat(this.fileFor(status, id))
        return status
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    }
    return null
  }

  private async namesIn(status: OutboxStatus): Promise<string[]> {
    const names = await readdir(join(this.directory, status))
    return names.filter(name => name.endsWith('.json')).sort()
  }

  private async readEntry(status: OutboxStatus, id: string): Promise<OutboxEntry> {
    const raw = await readFile(this.fileFor(status, id), 'utf8')
    return JSON.parse(raw) as OutboxEntry
  }

  private fileFor(status: OutboxStatus, id: string): string {
    return join(this.directory, status, `${id}.json`)
  }

  private async writeAt(target: string, entry: OutboxEntry): Promise<void> {
    const temporary = `${target}.tmp`
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
