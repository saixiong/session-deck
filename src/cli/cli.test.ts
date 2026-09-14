import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewStore } from '../analyze/ReviewStore'
import { FavoritesStore } from '../store/FavoritesStore'
import { main } from './main'

const FIXTURES = resolve(__dirname, '../../test/fixtures/claude/projects')
const FAKE = resolve(__dirname, '../../test/fixtures/fake-claude.sh')
const A = '11111111-1111-4111-8111-111111111111'

let dataDir: string
let out: string[]
let err: string[]

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'deck-cli-'))
  process.env['SESSION_DECK_DATA_DIR'] = dataDir
  process.env['SESSION_DECK_PROJECTS_DIR'] = FIXTURES
  process.env['SESSION_DECK_CLAUDE'] = FAKE
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.map(String).join(' '))
  )
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.map(String).join(' '))
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env['SESSION_DECK_DATA_DIR']
  delete process.env['SESSION_DECK_PROJECTS_DIR']
  delete process.env['SESSION_DECK_CLAUDE']
  await rm(dataDir, { recursive: true, force: true })
})

describe('session-deck CLI', () => {
  it('help exits 0, unknown command exits 2', async () => {
    expect(await main([])).toBe(0)
    expect(out.join('\n')).toContain('session-deck list')
    expect(await main(['bogus'])).toBe(2)
  })

  it('list → star → list --json → unstar, sharing favorites.json with the extension store', async () => {
    expect(await main(['list'])).toBe(0)
    expect(out.at(-1)).toMatch(/No favorites yet/)
    expect(await main(['star', A])).toBe(0)
    expect(out.at(-1)).toContain('Starred "Fix login bug and ship"')
    expect(await main(['star', 'not-a-session'])).toBe(1)
    expect(await main(['list', '--json'])).toBe(0)
    const rows = JSON.parse(out.at(-1)!) as Array<{
      session_id: string
      title: string
      priority: number | null
    }>
    expect(rows).toEqual([
      expect.objectContaining({ session_id: A, title: 'Fix login bug and ship', priority: null }),
    ])
    const ext = new FavoritesStore(join(dataDir, 'favorites.json'))
    await ext.load()
    expect(ext.has('session', A)).toBe(true)
    expect(await main(['unstar', A])).toBe(0)
    expect(await main(['unstar', A])).toBe(0)
    expect(out.at(-1)).toMatch(/was not a favorite/)
  })

  it('review --run analyses through the CLI and writes a report the extension store reads back', async () => {
    await main(['star', A])
    expect(await main(['review', '--run', '--model', 'haiku'])).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('priority 4 High')
    expect(text).toContain('prompt: Merge PR #42 and confirm CI passed.')
    expect(err.join('\n')).toMatch(/analysed 1, failed 0/)
    const store = new ReviewStore(join(dataDir, 'reviews'))
    await store.load()
    expect(store.get(A)?.model).toBe('haiku')
    // Fresh → not re-run; the JSON form carries the stale flag.
    out = []
    expect(await main(['review', A, '--json'])).toBe(0)
    const parsed = JSON.parse(out.at(-1)!) as Array<{ conversation_id: string; stale: boolean }>
    expect(parsed[0]).toMatchObject({ conversation_id: A, stale: false })
    expect(await main(['show', A])).toBe(0)
    expect(await main(['show', '22222222-2222-4222-8222-222222222222'])).toBe(1)
  })

  it('a failing CLI is reported and exits non-zero', async () => {
    process.env['FAKE_CLAUDE_FAIL'] = '1'
    try {
      expect(await main(['review', A, '--run'])).toBe(1)
      expect(err.join('\n')).toMatch(/Not logged in/)
    } finally {
      delete process.env['FAKE_CLAUDE_FAIL']
    }
  })
})
