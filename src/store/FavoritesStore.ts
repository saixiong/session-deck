import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { writeFileAtomic } from '../util/atomicWrite'

/**
 * `~/.session-deck/favorites.json` (spec §4.1). One generic list keyed by
 * (entity_type, entity_id) — D6 — with a REAL sort_order so drag-to-reorder
 * inserts between neighbours without rewriting every row.
 *
 * The file is the event bus between VS Code windows: every write is atomic,
 * and a watcher on the directory reloads on external change. Our own writes
 * are recognised by content so they do not echo back as changes.
 */

export type FavoriteEntityType = 'session' | 'project' | 'pr'
export const FAVORITE_ENTITY_TYPES: readonly FavoriteEntityType[] = ['session', 'project', 'pr']

export interface Favorite {
  id: string
  entity_type: FavoriteEntityType
  entity_id: string
  /** Title snapshot at star time — what a `missing` card shows. */
  label: string
  note: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

interface FavoritesFile {
  version: 1
  favorites: Favorite[]
}

export const SORT_STEP = 1024
export const LABEL_MAX = 500
export const NOTE_MAX = 2000
export const ENTITY_ID_MAX = 512

export type FavoritesListener = (favorites: Favorite[]) => void

export class FavoritesStore {
  private favorites: Favorite[] = []
  private readonly listeners = new Set<FavoritesListener>()
  private watcher: FSWatcher | undefined
  private reloadTimer: NodeJS.Timeout | undefined
  private lastWritten = ''
  private loaded = false

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    this.favorites = await readFavorites(this.path)
    this.loaded = true
  }

  /** Reload on external change (another window, the P6 skill, a hand edit). */
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
    // The directory may not exist until the first star; create it so the
    // watcher has something to attach to.
    void mkdir(dir, { recursive: true }).then(arm, arm)
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.listeners.clear()
  }

  onDidChange(listener: FavoritesListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): Favorite[] {
    return [...this.favorites].sort((a, b) => a.sort_order - b.sort_order)
  }

  listByType(type: FavoriteEntityType): Favorite[] {
    return this.list().filter((f) => f.entity_type === type)
  }

  get(entityType: FavoriteEntityType, entityId: string): Favorite | undefined {
    return this.favorites.find((f) => f.entity_type === entityType && f.entity_id === entityId)
  }

  getById(id: string): Favorite | undefined {
    return this.favorites.find((f) => f.id === id)
  }

  has(entityType: FavoriteEntityType, entityId: string): boolean {
    return this.get(entityType, entityId) !== undefined
  }

  /** Idempotent: starring twice returns the existing row unchanged. */
  async add(input: {
    entityType: FavoriteEntityType
    entityId: string
    label: string
    note?: string | null
  }): Promise<Favorite> {
    this.assertLoaded()
    if (!FAVORITE_ENTITY_TYPES.includes(input.entityType)) {
      throw new Error(`unknown favorite entity type: ${String(input.entityType)}`)
    }
    if (!input.entityId || input.entityId.length > ENTITY_ID_MAX)
      throw new Error('invalid entity id')
    const existing = this.get(input.entityType, input.entityId)
    if (existing) return existing
    const now = new Date().toISOString()
    const maxOrder = this.favorites.reduce((m, f) => Math.max(m, f.sort_order), 0)
    const favorite: Favorite = {
      id: `fav_${randomBytes(6).toString('hex')}`,
      entity_type: input.entityType,
      entity_id: input.entityId,
      label: (input.label || input.entityId).slice(0, LABEL_MAX),
      note: input.note ? input.note.slice(0, NOTE_MAX) : null,
      sort_order: maxOrder + SORT_STEP,
      created_at: now,
      updated_at: now,
    }
    this.favorites.push(favorite)
    await this.persist()
    return favorite
  }

  async removeById(id: string): Promise<boolean> {
    this.assertLoaded()
    const before = this.favorites.length
    this.favorites = this.favorites.filter((f) => f.id !== id)
    if (this.favorites.length === before) return false
    await this.persist()
    return true
  }

  async removeByEntity(entityType: FavoriteEntityType, entityId: string): Promise<boolean> {
    const existing = this.get(entityType, entityId)
    return existing ? this.removeById(existing.id) : false
  }

  async update(
    id: string,
    patch: { label?: string; note?: string | null; sort_order?: number }
  ): Promise<Favorite | undefined> {
    this.assertLoaded()
    const favorite = this.getById(id)
    if (!favorite) return undefined
    if (patch.label !== undefined) favorite.label = patch.label.slice(0, LABEL_MAX)
    if (patch.note !== undefined) favorite.note = patch.note ? patch.note.slice(0, NOTE_MAX) : null
    if (patch.sort_order !== undefined && Number.isFinite(patch.sort_order))
      favorite.sort_order = patch.sort_order
    favorite.updated_at = new Date().toISOString()
    await this.persist()
    return favorite
  }

  /**
   * Move `id` so it sits between `beforeId`'s predecessor and `beforeId`
   * (or last when `beforeId` is undefined), using the fractional gap. When
   * the gap closes (< 1e-6) the whole list is renumbered once.
   */
  async moveBefore(id: string, beforeId: string | undefined): Promise<void> {
    this.assertLoaded()
    const moving = this.getById(id)
    if (!moving || id === beforeId) return
    const ordered = this.list().filter((f) => f.id !== id)
    let order: number
    if (beforeId === undefined) {
      const last = ordered[ordered.length - 1]
      order = (last?.sort_order ?? 0) + SORT_STEP
    } else {
      const idx = ordered.findIndex((f) => f.id === beforeId)
      if (idx === -1) return
      const next = ordered[idx]!.sort_order
      const prev = idx === 0 ? next - SORT_STEP : ordered[idx - 1]!.sort_order
      order = (prev + next) / 2
      if (next - prev < 1e-6) {
        ordered.splice(idx, 0, moving)
        ordered.forEach((f, i) => (f.sort_order = (i + 1) * SORT_STEP))
        moving.updated_at = new Date().toISOString()
        await this.persist()
        return
      }
    }
    moving.sort_order = order
    moving.updated_at = new Date().toISOString()
    await this.persist()
  }

  /** Rewrite sort_order for the given ids in one write (spec §6 `reorder`). */
  async reorder(orderedIds: string[]): Promise<void> {
    this.assertLoaded()
    let i = 1
    for (const id of orderedIds) {
      const favorite = this.getById(id)
      if (favorite) favorite.sort_order = i++ * SORT_STEP
    }
    await this.persist()
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('FavoritesStore.load() has not run')
  }

  private async persist(): Promise<void> {
    const file: FavoritesFile = { version: 1, favorites: this.list() }
    const text = JSON.stringify(file, null, 2) + '\n'
    this.lastWritten = text
    await writeFileAtomic(this.path, text)
    this.emit()
  }

  private async reloadIfChanged(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      raw = ''
    }
    if (raw === this.lastWritten) return
    this.favorites = parseFavorites(raw)
    this.lastWritten = raw
    this.emit()
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A listener's failure must not break the store or other listeners.
      }
    }
  }
}

async function readFavorites(path: string): Promise<Favorite[]> {
  try {
    return parseFavorites(await readFile(path, 'utf8'))
  } catch {
    return []
  }
}

/** Tolerant: a corrupt file or a row from a newer schema degrades to what is readable. */
export function parseFavorites(raw: string): Favorite[] {
  if (!raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const rows = (parsed as { favorites?: unknown }).favorites
  if (!Array.isArray(rows)) return []
  const out: Favorite[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const entityType = r['entity_type']
    if (typeof r['id'] !== 'string' || typeof r['entity_id'] !== 'string') continue
    if (!FAVORITE_ENTITY_TYPES.includes(entityType as FavoriteEntityType)) continue
    const key = `${String(entityType)}:${r['entity_id']}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: r['id'],
      entity_type: entityType as FavoriteEntityType,
      entity_id: r['entity_id'],
      label: typeof r['label'] === 'string' ? r['label'] : r['entity_id'],
      note: typeof r['note'] === 'string' ? r['note'] : null,
      sort_order:
        typeof r['sort_order'] === 'number' && Number.isFinite(r['sort_order'])
          ? r['sort_order']
          : out.length * SORT_STEP,
      created_at: typeof r['created_at'] === 'string' ? r['created_at'] : '',
      updated_at: typeof r['updated_at'] === 'string' ? r['updated_at'] : '',
    })
  }
  return out
}
