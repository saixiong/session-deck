import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardKey, itemIdOf } from '../shared/board'
import { BoardStore, SEEDED_TTL_DAYS } from './BoardStore'

let root: string
let store: BoardStore
const item = (text: string) => ({ id: itemIdOf(text), text })
const MERGE = item('Merge PR #42')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-board-'))
  store = new BoardStore(join(root, 'board.json'))
  await store.load()
})
afterEach(async () => {
  store.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('BoardStore', () => {
  it('writes, reads back through a second store, and clears with null', async () => {
    await store.setState('s1', MERGE, 'done')
    expect(store.get('s1', MERGE.id)).toMatchObject({ state: 'done', text: 'Merge PR #42' })

    const other = new BoardStore(store.path)
    await other.load()
    expect(other.get('s1', MERGE.id)?.state).toBe('done')
    other.dispose()

    await store.setState('s1', MERGE, null)
    expect(store.get('s1', MERGE.id)).toBeUndefined()
    // Clearing something that was never set is a no-op, not a throw.
    await store.setState('s1', MERGE, null)
  })

  it('keys by session and item, so the same text in two sessions is two rows', async () => {
    await store.setStates([
      { sessionId: 's1', item: MERGE, state: 'done' },
      { sessionId: 's2', item: MERGE, state: 'dismissed' },
    ])
    expect(store.get('s1', MERGE.id)?.state).toBe('done')
    expect(store.get('s2', MERGE.id)?.state).toBe('dismissed')
    expect(Object.keys(store.all())).toEqual([boardKey('s1', MERGE.id), boardKey('s2', MERGE.id)])
  })

  it('state survives a re-analysis that did not reword the item, and not one that did', async () => {
    await store.setState('s1', MERGE, 'done')
    // Same item, reworded by the model on the next pass → a new id → open again.
    const reworded = item('Merge pull request #42')
    expect(store.get('s1', reworded.id)).toBeUndefined()
    // Same text with different punctuation/case is the SAME item.
    expect(store.get('s1', itemIdOf('  merge pr #42.  '))?.state).toBe('done')
  })

  it('keeps seeded_at across a later state change and stamps it once', async () => {
    await store.setState('s1', MERGE, 'seeded')
    const seededAt = store.get('s1', MERGE.id)?.seeded_at
    expect(seededAt).toBeTruthy()
    await store.setState('s1', MERGE, 'done')
    expect(store.get('s1', MERGE.id)).toMatchObject({ state: 'done', seeded_at: seededAt })
  })

  it('prunes only old seeded rows of unstarred sessions', async () => {
    await store.setStates([
      { sessionId: 'old', item: MERGE, state: 'seeded' },
      { sessionId: 'starred', item: MERGE, state: 'seeded' },
      { sessionId: 'decided', item: MERGE, state: 'done' },
    ])
    const later = Date.now() + (SEEDED_TTL_DAYS + 1) * 24 * 60 * 60 * 1000
    expect(await store.prune(new Set(['starred']), later)).toBe(1)
    expect(store.get('old', MERGE.id)).toBeUndefined()
    expect(store.get('starred', MERGE.id)?.state).toBe('seeded')
    expect(store.get('decided', MERGE.id)?.state).toBe('done')
    // Fresh rows survive even when their session is unstarred.
    expect(await store.prune(new Set(), Date.now())).toBe(0)
  })

  it('notifies listeners, and a corrupt or partial file degrades to empty', async () => {
    let fired = 0
    const off = store.onDidChange(() => fired++)
    await store.setState('s1', MERGE, 'done')
    expect(fired).toBe(1)
    // Writing the same state again changes nothing, so no event.
    await store.setState('s1', MERGE, 'done')
    expect(fired).toBe(1)
    off()

    await writeFile(join(root, 'bad.json'), '{ not json', 'utf8')
    const bad = new BoardStore(join(root, 'bad.json'))
    await bad.load()
    expect(bad.all()).toEqual({})
    bad.dispose()

    await writeFile(
      join(root, 'partial.json'),
      JSON.stringify({ version: 1, items: { 'a:b': { state: 'nonsense' }, 'c:d': 7 } }),
      'utf8'
    )
    const partial = new BoardStore(join(root, 'partial.json'))
    await partial.load()
    expect(partial.all()).toEqual({})
    partial.dispose()
  })

  it('writes atomically with a trailing newline and leaves no temp files', async () => {
    await store.setState('s1', MERGE, 'done')
    const raw = await readFile(store.path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toMatchObject({ version: 1 })
  })

  it('refuses to write before load()', async () => {
    const cold = new BoardStore(join(root, 'cold.json'))
    await expect(cold.setState('s1', MERGE, 'done')).rejects.toThrow(/load/)
    cold.dispose()
  })
})
