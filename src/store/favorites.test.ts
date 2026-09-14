import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FavoritesStore, parseFavorites, SORT_STEP } from './FavoritesStore'

let root: string
let path: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-fav-'))
  path = join(root, 'data', 'favorites.json')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fresh(): Promise<FavoritesStore> {
  const store = new FavoritesStore(path)
  await store.load()
  return store
}

describe('FavoritesStore', () => {
  it('starts empty when the file does not exist and creates it on first add', async () => {
    const store = await fresh()
    expect(store.list()).toEqual([])
    const fav = await store.add({ entityType: 'session', entityId: 's1', label: 'One' })
    expect(fav.id).toMatch(/^fav_[0-9a-f]{12}$/)
    expect(fav.sort_order).toBe(SORT_STEP)
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
      version: number
      favorites: unknown[]
    }
    expect(onDisk.version).toBe(1)
    expect(onDisk.favorites).toHaveLength(1)
  })

  it('add is idempotent on (entity_type, entity_id)', async () => {
    const store = await fresh()
    const a = await store.add({ entityType: 'session', entityId: 's1', label: 'One' })
    const b = await store.add({ entityType: 'session', entityId: 's1', label: 'Renamed' })
    expect(b).toBe(a)
    expect(store.list()).toHaveLength(1)
    expect(store.has('session', 's1')).toBe(true)
  })

  it('rejects unknown types and bad ids, and bounds text fields', async () => {
    const store = await fresh()
    await expect(
      store.add({ entityType: 'nope' as never, entityId: 'x', label: 'x' })
    ).rejects.toThrow(/unknown/)
    await expect(store.add({ entityType: 'session', entityId: '', label: 'x' })).rejects.toThrow(
      /invalid/
    )
    const fav = await store.add({
      entityType: 'session',
      entityId: 's1',
      label: 'L'.repeat(1000),
      note: 'N'.repeat(5000),
    })
    expect(fav.label).toHaveLength(500)
    expect(fav.note).toHaveLength(2000)
  })

  it('removes by id and by entity; removing twice is a no-op', async () => {
    const store = await fresh()
    const fav = await store.add({ entityType: 'session', entityId: 's1', label: 'One' })
    await store.add({ entityType: 'session', entityId: 's2', label: 'Two' })
    expect(await store.removeById(fav.id)).toBe(true)
    expect(await store.removeById(fav.id)).toBe(false)
    expect(await store.removeByEntity('session', 's2')).toBe(true)
    expect(await store.removeByEntity('session', 's2')).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('moveBefore uses the fractional gap and renumbers when it closes', async () => {
    const store = await fresh()
    const a = await store.add({ entityType: 'session', entityId: 'a', label: 'a' })
    const b = await store.add({ entityType: 'session', entityId: 'b', label: 'b' })
    const c = await store.add({ entityType: 'session', entityId: 'c', label: 'c' })
    await store.moveBefore(c.id, a.id)
    expect(store.list().map((f) => f.entity_id)).toEqual(['c', 'a', 'b'])
    expect(store.getById(c.id)!.sort_order).toBe(SORT_STEP / 2)
    await store.moveBefore(b.id, a.id)
    expect(store.list().map((f) => f.entity_id)).toEqual(['c', 'b', 'a'])
    // Squeeze the gap shut and confirm a renumber happens rather than a collision.
    for (let i = 0; i < 60; i++) await store.moveBefore(store.list()[2]!.id, store.list()[1]!.id)
    const orders = store.list().map((f) => f.sort_order)
    expect(new Set(orders).size).toBe(3)
    await store.moveBefore(a.id, undefined)
    expect(store.list()[2]!.entity_id).toBe('a')
  })

  it('reorder rewrites sort_order in one write', async () => {
    const store = await fresh()
    const a = await store.add({ entityType: 'session', entityId: 'a', label: 'a' })
    const b = await store.add({ entityType: 'session', entityId: 'b', label: 'b' })
    await store.reorder([b.id, a.id])
    expect(store.list().map((f) => f.entity_id)).toEqual(['b', 'a'])
  })

  it('update patches note/label and bumps updated_at', async () => {
    const store = await fresh()
    const a = await store.add({ entityType: 'session', entityId: 'a', label: 'a' })
    const updated = await store.update(a.id, { note: 'remember this', label: 'A!' })
    expect(updated?.note).toBe('remember this')
    expect(updated?.label).toBe('A!')
    expect(await store.update('fav_nope', { note: 'x' })).toBeUndefined()
  })

  it('a second store instance sees the first one’s writes on load', async () => {
    const first = await fresh()
    await first.add({ entityType: 'session', entityId: 's1', label: 'One' })
    const second = await fresh()
    expect(second.list().map((f) => f.entity_id)).toEqual(['s1'])
  })

  it('parseFavorites tolerates corruption, drops duplicates and unknown types', () => {
    expect(parseFavorites('')).toEqual([])
    expect(parseFavorites('garbage')).toEqual([])
    expect(parseFavorites('{"favorites":"no"}')).toEqual([])
    const rows = parseFavorites(
      JSON.stringify({
        favorites: [
          { id: 'fav_1', entity_type: 'session', entity_id: 's1', label: 'x', sort_order: 5 },
          { id: 'fav_2', entity_type: 'session', entity_id: 's1', label: 'dup' },
          { id: 'fav_3', entity_type: 'alien', entity_id: 'z' },
          { id: 'fav_4', entity_type: 'session', entity_id: 's2' },
          'not a row',
        ],
      })
    )
    expect(rows.map((r) => r.id)).toEqual(['fav_1', 'fav_4'])
    expect(rows[1]?.label).toBe('s2')
  })

  it('notifies listeners on writes and on external file changes', async () => {
    const store = await fresh()
    const seen: number[] = []
    store.onDidChange((favs) => seen.push(favs.length))
    await store.add({ entityType: 'session', entityId: 's1', label: 'One' })
    expect(seen).toEqual([1])
    store.watch()
    await new Promise((r) => setTimeout(r, 50))
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        favorites: [{ id: 'fav_x', entity_type: 'session', entity_id: 'ext', label: 'External' }],
      })
    )
    await new Promise((r) => setTimeout(r, 400))
    expect(store.list().map((f) => f.entity_id)).toEqual(['ext'])
    expect(seen[seen.length - 1]).toBe(1)
    store.dispose()
  })

  it('refuses to mutate before load()', async () => {
    const store = new FavoritesStore(path)
    await expect(store.add({ entityType: 'session', entityId: 'x', label: 'x' })).rejects.toThrow(
      /load/
    )
  })
})
