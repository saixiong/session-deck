import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContentIndex, SNIPPET_CHARS } from './ContentIndex'
import { rec, toJsonl, ts } from './testFixtures'
import { newEntry } from './tiers'
import type { SessionIndexEntry } from './types'

let root: string
let index: ContentIndex

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const o = (sessionId: string) => ({ sessionId })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-content-'))
  index = new ContentIndex({ dir: join(root, 'content') })
  await index.load()
})
afterEach(async () => {
  await index.dispose()
  await rm(root, { recursive: true, force: true })
})

async function session(id: string, records: unknown[]): Promise<SessionIndexEntry> {
  const file = join(root, `${id}.jsonl`)
  await writeFile(file, toJsonl(records))
  return entryFor(id, file)
}

async function entryFor(id: string, file: string): Promise<SessionIndexEntry> {
  const size = (await readFile(file)).length
  const e = newEntry(file, size, 1)
  e.sessionId = id
  return e
}

describe('ContentIndex', () => {
  it('indexes user and assistant text only — not tool results, thinking or meta', async () => {
    const a = await session(A, [
      rec.user(o(A), 'Please fix the login bug', ts(0)),
      rec.systemReminderUser(o(A), ts(1)),
      rec.assistant(o(A), 'Looking at auth/session.py now', ts(2), { tools: 1, thinking: true }),
      rec.toolResultUser(o(A), ts(3)),
      rec.assistant(o(A), 'Fixed: the cookie was never cleared on logout', ts(4)),
    ])
    await index.catchUp([a])
    expect(index.contains(A, ['login'])).toBe(true)
    expect(index.contains(A, ['cookie', 'logout'])).toBe(true)
    expect(index.contains(A, ['injected'])).toBe(false) // the meta system-reminder
    expect(index.contains(A, ['hmm'])).toBe(false) // thinking
    expect(index.contains(A, ['ls'])).toBe(false) // the tool call's input
    expect(index.wordsIn(A, ['cookie', 'zebra'])).toEqual(['cookie'])
    const text = await readFile(join(root, 'content', `${A}.txt`), 'utf8')
    expect(text.split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('appends only the new bytes of a transcript that grew, and persists offsets', async () => {
    const a = await session(A, [rec.user(o(A), 'first thing', ts(0))])
    await index.catchUp([a])
    expect(index.contains(A, ['second'])).toBe(false)

    await appendFile(a.filePath, toJsonl([rec.assistant(o(A), 'second thing', ts(1))]))
    const grown = await entryFor(A, a.filePath)
    await index.catchUp([grown])
    expect(index.contains(A, ['first', 'second'])).toBe(true)
    // The file holds each message once: nothing was re-read from zero.
    const text = await readFile(join(root, 'content', `${A}.txt`), 'utf8')
    expect(text.match(/first thing/g)).toHaveLength(1)

    await index.dispose()
    const manifest = JSON.parse(await readFile(join(root, 'content', 'manifest.json'), 'utf8')) as {
      sessions: Record<string, { to: number; size: number }>
    }
    expect(manifest.sessions[A]?.to).toBe(grown.size)

    // A fresh instance loads what was written and does not re-index an unchanged session.
    const again = new ContentIndex({ dir: join(root, 'content') })
    await again.load()
    expect(again.contains(A, ['second'])).toBe(true)
    await again.catchUp([grown])
    expect(
      (await readFile(join(root, 'content', `${A}.txt`), 'utf8')).match(/second/g)
    ).toHaveLength(1)
    await again.dispose()
  })

  it('rebuilds from zero when a transcript shrank', async () => {
    const a = await session(A, [rec.user(o(A), 'alpha', ts(0)), rec.assistant(o(A), 'beta', ts(1))])
    await index.catchUp([a])
    await writeFile(a.filePath, toJsonl([rec.user(o(A), 'gamma', ts(0))]))
    await index.catchUp([await entryFor(A, a.filePath)])
    expect(index.contains(A, ['gamma'])).toBe(true)
    expect(index.contains(A, ['alpha'])).toBe(false)
  })

  it('skips missing sessions and reports a failed one without stopping the rest', async () => {
    const a = await session(A, [rec.user(o(A), 'alpha', ts(0))])
    const gone = { ...a, sessionId: B, filePath: join(root, 'nope.jsonl') }
    const missing = { ...a, sessionId: 'c', missing: true }
    const logs: string[] = []
    const noisy = new ContentIndex({ dir: join(root, 'content'), log: (m) => logs.push(m) })
    await noisy.load()
    await noisy.catchUp([gone, missing, a])
    expect(noisy.contains(A, ['alpha'])).toBe(true)
    expect(noisy.contains(B, [])).toBe(false)
    expect(logs.some((l) => l.includes(B) && l.includes('failed'))).toBe(true)
    await noisy.dispose()
  })

  it('snippets keep the original case, centre the word, and mark the cut ends', async () => {
    const long = `${'x'.repeat(200)} The Cookie was never cleared ${'y'.repeat(200)}`
    const a = await session(A, [rec.assistant(o(A), long, ts(0))])
    await index.catchUp([a])
    const snippet = await index.snippet(A, 'cookie')
    expect(snippet).toBeDefined()
    expect(snippet).toContain('The Cookie was never cleared')
    expect(snippet!.startsWith('…')).toBe(true)
    expect(snippet!.endsWith('…')).toBe(true)
    expect(snippet!.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2)
    expect(await index.snippet(A, 'zebra')).toBeUndefined()
    expect(await index.snippet(B, 'cookie')).toBeUndefined()
  })

  it('an unknown session contains nothing, even the empty query', () => {
    expect(index.contains(B, [])).toBe(false)
    expect(index.wordsIn(B, ['a'])).toEqual([])
  })
})
