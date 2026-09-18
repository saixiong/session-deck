import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { itemIdOf } from '../shared/board'
import { BoardStore } from './BoardStore'
import { FavoritesStore } from './FavoritesStore'

// vi.mock is hoisted above the imports, so the stores below get the gated
// readFile. It is held open on demand so a save can land in the middle of a
// watcher reload — the exact interleaving CI hit: the previous test's save
// armed the watcher, its 150 ms reload began reading, and the next test's
// write finished before the read returned stale bytes.
const gate: { hold: boolean; release: () => void } = { hold: false, release: () => undefined }
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const bytes = await real.readFile(...args)
      if (gate.hold) await new Promise<void>((r) => (gate.release = r))
      return bytes
    },
  }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-race-'))
  gate.hold = false
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type Reloadable = { reloadIfChanged(): Promise<void> }

describe('a watcher reload that overlaps a save', () => {
  it('BoardStore keeps the write, not the stale bytes it was reading', async () => {
    const store = new BoardStore(join(root, 'board.json'))
    await store.load()
    const item = { id: itemIdOf('Merge PR #42'), text: 'Merge PR #42' }
    // Something already on disk, so the held read returns real (stale) bytes.
    await store.setState('s1', { id: itemIdOf('Older'), text: 'Older' }, 'dismissed')

    gate.hold = true
    const reload = (store as unknown as Reloadable).reloadIfChanged() // reads the empty file, then waits
    await new Promise((r) => setTimeout(r, 10))
    gate.hold = false
    await store.setState('s1', item, 'done') // lands while the read is held
    gate.release()
    await reload

    expect(store.get('s1', item.id)?.state).toBe('done')
    store.dispose()
  })

  it('FavoritesStore keeps the write, not the stale bytes it was reading', async () => {
    const store = new FavoritesStore(join(root, 'favorites.json'))
    await store.load()
    await store.add({ entityType: 'session', entityId: 'older', label: 'Older' })

    gate.hold = true
    const reload = (store as unknown as Reloadable).reloadIfChanged()
    await new Promise((r) => setTimeout(r, 10))
    gate.hold = false
    await store.add({ entityType: 'session', entityId: 'a', label: 'A' })
    gate.release()
    await reload

    expect(store.has('session', 'a')).toBe(true)
    store.dispose()
  })
})
