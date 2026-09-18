import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { boardKey, type BoardItemState } from '../shared/board'
import { writeFileAtomic } from '../util/atomicWrite'

/**
 * `~/.session-deck/board.json` (SPEC_BOARD B3.2): what you have done,
 * dismissed or seeded, keyed by `sessionId:hash(normalised text)` so the state
 * survives a re-analysis that did not reword the item (B4). Exact match or
 * nothing — a reworded item honestly reappears as new work (B5).
 *
 * Same contract as FavoritesStore: atomic write-then-rename, a directory
 * watcher for other windows and the skill CLI, our own writes recognised by
 * content so they do not echo back.
 */

export interface BoardEntry {
  state: BoardItemState
  /** Snapshot, so an item its report no longer lists is still nameable. */
  text: string
  session_id: string
  updated_at: string
  seeded_at: string | null
}

interface BoardFile {
  version: 1
  items: Record<string, BoardEntry>
}

export const TEXT_MAX = 2000
/** `seeded` rows for sessions nobody stars any more expire; decisions are kept (B3.2). */
export const SEEDED_TTL_DAYS = 30

export type BoardListener = () => void

export class BoardStore {
  private items: Record<string, BoardEntry> = {}
  private readonly listeners = new Set<BoardListener>()
  private watcher: FSWatcher | undefined
  private reloadTimer: NodeJS.Timeout | undefined
  private lastWritten = ''
  /** Bumped by every save; a reload that overlapped one discards what it read. */
  private writeGeneration = 0
  private loaded = false

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    this.items = await readBoard(this.path)
    this.loaded = true
  }

  watch(): void {
    if (this.watcher) return
    const dir = dirname(this.path)
    const name = basename(this.path)
    const arm = () => {
      try {
        this.watcher = watch(dir, (_event, filename) => {
          if (filename && filename !== name) return
          if (this.reloadTimer) clearTimeout(this.reloadTimer)
          this.reloadTimer = setTimeout(() => void this.reloadIfChanged(), 150)
        })
        this.watcher.on('error', () => {
          this.watcher?.close()
          this.watcher = undefined
        })
      } catch {
        this.watcher = undefined
      }
    }
    void mkdir(dir, { recursive: true }).then(arm, arm)
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.listeners.clear()
  }

  onDidChange(listener: BoardListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  all(): Record<string, BoardEntry> {
    return { ...this.items }
  }

  get(sessionId: string, itemId: string): BoardEntry | undefined {
    return this.items[boardKey(sessionId, itemId)]
  }

  /** `null` clears the row back to open. Idempotent; no write when nothing changes. */
  async setState(
    sessionId: string,
    item: { id: string; text: string },
    state: BoardItemState | null
  ): Promise<void> {
    await this.setStates([{ sessionId, item, state }])
  }

  /** One write for a whole bulk action — the Board's Done / Dismiss / Seed all touch many rows. */
  async setStates(
    updates: readonly {
      sessionId: string
      item: { id: string; text: string }
      state: BoardItemState | null
    }[]
  ): Promise<void> {
    this.assertLoaded()
    const now = new Date().toISOString()
    let changed = false
    for (const { sessionId, item, state } of updates) {
      if (!sessionId || !item.id) continue
      const key = boardKey(sessionId, item.id)
      const existing = this.items[key]
      if (state === null) {
        if (existing) {
          delete this.items[key]
          changed = true
        }
        continue
      }
      if (existing?.state === state && existing.text === item.text.slice(0, TEXT_MAX)) continue
      this.items[key] = {
        state,
        text: item.text.slice(0, TEXT_MAX),
        session_id: sessionId,
        updated_at: now,
        seeded_at: state === 'seeded' ? now : (existing?.seeded_at ?? null),
      }
      changed = true
    }
    if (changed) await this.save()
  }

  /**
   * Drop `seeded` rows for sessions that are no longer starred once they are
   * older than the TTL, so the file cannot grow without bound. `done` and
   * `dismissed` are decisions and are kept regardless (B3.2).
   */
  async prune(starred: ReadonlySet<string>, now = Date.now()): Promise<number> {
    this.assertLoaded()
    const cutoff = now - SEEDED_TTL_DAYS * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [key, entry] of Object.entries(this.items)) {
      if (entry.state !== 'seeded') continue
      if (starred.has(entry.session_id)) continue
      const at = Date.parse(entry.seeded_at ?? entry.updated_at)
      if (Number.isFinite(at) && at > cutoff) continue
      delete this.items[key]
      removed++
    }
    if (removed) await this.save()
    return removed
  }

  private async save(): Promise<void> {
    const file: BoardFile = { version: 1, items: this.items }
    const json = `${JSON.stringify(file, null, 2)}\n`
    this.writeGeneration++
    this.lastWritten = json
    await mkdir(dirname(this.path), { recursive: true })
    await writeFileAtomic(this.path, json)
    this.emit()
  }

  private async reloadIfChanged(): Promise<void> {
    // A reload is only trustworthy if no save ran while the file was being
    // read. Otherwise the bytes on disk can predate the write we just made
    // and, since they no longer match `lastWritten`, would be adopted —
    // silently undoing the write. The save's own change event brings the
    // watcher back for a clean read.
    const generation = this.writeGeneration
    let raw = ''
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      raw = ''
    }
    if (generation !== this.writeGeneration) return
    if (raw === this.lastWritten) return
    this.items = parseBoard(raw)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('BoardStore.load() must run before writing')
  }
}

async function readBoard(path: string): Promise<Record<string, BoardEntry>> {
  try {
    return parseBoard(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

/** A corrupt or hand-edited file degrades to "no state", never to a throw on activation. */
function parseBoard(raw: string): Record<string, BoardEntry> {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const items = (parsed as { items?: unknown }).items
  if (typeof items !== 'object' || items === null) return {}
  const out: Record<string, BoardEntry> = {}
  for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const v = value as Record<string, unknown>
    const state = v['state']
    if (state !== 'done' && state !== 'dismissed' && state !== 'seeded') continue
    const sessionId = typeof v['session_id'] === 'string' ? v['session_id'] : key.split(':')[0]
    if (!sessionId) continue
    out[key] = {
      state,
      text: typeof v['text'] === 'string' ? v['text'].slice(0, TEXT_MAX) : '',
      session_id: sessionId,
      updated_at: typeof v['updated_at'] === 'string' ? v['updated_at'] : '',
      seeded_at: typeof v['seeded_at'] === 'string' ? v['seeded_at'] : null,
    }
  }
  return out
}
