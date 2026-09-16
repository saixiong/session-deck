import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewStore } from '../analyze/ReviewStore'
import { itemIdOf, reconcileItems } from '../shared/board'
import type { ChatReview } from '../shared/review'
import { BoardStore } from '../store/BoardStore'
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

const B = '22222222-2222-4222-8222-222222222222'

/** A cached report, written straight to the store — cmdBoard only ever reads them. */
async function seedReview(
  sessionId: string,
  priority: number,
  nextSteps: string[],
  blockers: string[] = []
): Promise<void> {
  const store = new ReviewStore(join(dataDir, 'reviews'))
  await store.load()
  const review: ChatReview = {
    conversation_id: sessionId,
    title: `Session ${sessionId.slice(0, 4)}`,
    summary: 'seeded',
    done: [],
    next_steps: nextSteps,
    blockers,
    priority,
    priority_label: 'High',
    priority_reason: 'seeded',
    completion: 50,
    completion_reason: 'seeded',
    items: reconcileItems(
      nextSteps,
      blockers,
      [...nextSteps, ...blockers].map((text) => ({ text, kind: 'mechanical' as const }))
    ),
    options: [{ id: 'o', label: 'Go', description: 'd', prompt: 'p' }],
    model: 'haiku',
    analyzed_at: new Date().toISOString(),
    fingerprint: 'seeded',
    message_count: 1,
    cost_usd: 0,
    duration_ms: 0,
    error: null,
  }
  await store.set(review)
}

interface BoardJsonRow {
  session_id: string
  text: string
  kind: string
  source: string
  state: string | null
}

describe('session-deck board', () => {
  const boardJson = () => JSON.parse(out.at(-1)!) as BoardJsonRow[]

  it('says the board is empty rather than printing nothing', async () => {
    expect(await main(['board'])).toBe(0)
    expect(out.at(-1)).toMatch(/Nothing outstanding/)
  })

  it('prints the dashboard s order: priority first, then blockers before next steps', async () => {
    await main(['star', A])
    await main(['star', B])
    await seedReview(A, 2, ['Low priority step'])
    await seedReview(B, 5, ['Urgent step'], ['Urgent blocker'])
    expect(await main(['board', '--json'])).toBe(0)
    expect(boardJson().map((r) => [r.session_id === B ? 'B' : 'A', r.text])).toEqual([
      ['B', 'Urgent blocker'],
      ['B', 'Urgent step'],
      ['A', 'Low priority step'],
    ])
  })

  it('filters by kind and refuses a kind that is not one', async () => {
    await main(['star', A])
    await seedReview(A, 3, ['Merge the PR'])
    expect(await main(['board', '--kind', 'mechanical', '--json'])).toBe(0)
    expect(boardJson()).toHaveLength(1)
    expect(await main(['board', '--kind', 'decision', '--json'])).toBe(0)
    expect(boardJson()).toHaveLength(0)
    // A typo must not read as "you have no mechanical work left".
    expect(await main(['board', '--kind', 'mechnical'])).toBe(2)
    expect(err.join('\n')).toMatch(/Unknown kind "mechnical"/)
    expect(err.join('\n')).toMatch(/mechanical, decision, user_action, unclassified/)
  })

  it('hides done items until --all, sharing board.json with the extension store', async () => {
    await main(['star', A])
    await seedReview(A, 3, ['Merge the PR', 'Update the changelog'])
    expect(await main(['board', '--json'])).toBe(0)
    const [first] = boardJson()
    const store = new BoardStore(join(dataDir, 'board.json'))
    await store.load()
    await store.setState(A, { id: itemIdOf(first!.text), text: first!.text }, 'done')
    expect(await main(['board', '--json'])).toBe(0)
    expect(boardJson().map((r) => r.text)).toEqual(['Update the changelog'])
    expect(await main(['board', '--all', '--json'])).toBe(0)
    expect(boardJson().map((r) => r.state)).toEqual(['done', null])
  })

  it('--prompt composes one session s open items, and refuses an ambiguous id', async () => {
    const favorites = new FavoritesStore(join(dataDir, 'favorites.json'))
    await favorites.load()
    await favorites.add({ entityType: 'session', entityId: 'shared-one', label: 'One' })
    await favorites.add({ entityType: 'session', entityId: 'shared-two', label: 'Two' })
    await seedReview('shared-one', 3, ['Merge the PR', 'Update the changelog'])
    await seedReview('shared-two', 3, ['Something else'])

    expect(await main(['board', '--prompt', 'shared-one'])).toBe(0)
    const prompt = out.at(-1)!
    expect(prompt).toContain('1. Merge the PR')
    expect(prompt).toContain('2. Update the changelog')
    expect(prompt).not.toContain('Something else')

    // The prefix matches both sessions: seeding the wrong one is not recoverable.
    expect(await main(['board', '--prompt', 'shared-'])).toBe(2)
    expect(err.join('\n')).toMatch(/matches 2 sessions/)
    expect(await main(['board', '--prompt', 'nothing-like-this'])).toBe(1)
  })
})
