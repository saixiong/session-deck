import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadIndexCache, saveIndexCache } from './cache'
import { parseRecord, readHeadLines, readTailLines, splitLines, streamLines } from './jsonl'
import { isProcessAlive, parseLiveSession, readLiveSessions } from './liveSessions'
import { applyRecord, humanPromptOf, previewOf, resolveTitle, stripMarkdown } from './records'
import { SessionIndexer } from './SessionIndexer'
import {
  appendRecords,
  bigSession,
  ordinarySession,
  rec,
  toJsonl,
  ts,
  writeSession,
} from './testFixtures'
import { fastTier, fullTier, newEntry } from './tiers'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-deck-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const S = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

// --- jsonl -------------------------------------------------------------------

describe('jsonl readers', () => {
  it('head and tail return only complete lines and report bytes read', async () => {
    const file = join(root, 'a.jsonl')
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(100) }))
    await writeFile(file, lines.join('\n') + '\n')
    const head = await readHeadLines(file, { maxBytes: 4096, startBytes: 512 })
    expect(head.complete).toBe(false)
    expect(head.lines[0]).toBe(lines[0])
    for (const l of head.lines) expect(() => JSON.parse(l) as unknown).not.toThrow()
    expect(head.bytesRead).toBeLessThanOrEqual(4096)

    const tail = await readTailLines(file, { maxBytes: 4096, startBytes: 512 })
    expect(tail.complete).toBe(false)
    expect(tail.lines[tail.lines.length - 1]).toBe(lines[199])
    for (const l of tail.lines) expect(() => JSON.parse(l) as unknown).not.toThrow()
  })

  it('a small file is read completely by the head', async () => {
    const file = join(root, 'b.jsonl')
    await writeFile(file, '{"a":1}\n{"b":2}\n')
    const head = await readHeadLines(file, { maxBytes: 4096 })
    expect(head.complete).toBe(true)
    expect(head.lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('grows the read until `enough` is satisfied', async () => {
    const file = join(root, 'c.jsonl')
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(200) }))
    await writeFile(file, lines.join('\n') + '\n')
    const res = await readHeadLines(file, {
      maxBytes: 64 * 1024,
      startBytes: 256,
      enough: (ls) => ls.length >= 20,
    })
    expect(res.lines.length).toBeGreaterThanOrEqual(20)
  })

  it('streamLines yields newline-terminated lines with resume offsets and skips a partial tail', async () => {
    const file = join(root, 'd.jsonl')
    await writeFile(file, '{"a":1}\n{"b":2}\n{"partial":')
    const got: Array<{ line: string; endOffset: number }> = []
    for await (const l of streamLines(file)) got.push(l)
    expect(got.map((g) => g.line)).toEqual(['{"a":1}', '{"b":2}'])
    expect(got[1]?.endOffset).toBe('{"a":1}\n{"b":2}\n'.length)
    // Resume from the offset: the partial line is still not yielded until completed.
    const resumed: string[] = []
    for await (const l of streamLines(file, got[1]!.endOffset)) resumed.push(l.line)
    expect(resumed).toEqual([])
    await writeFile(file, '{"a":1}\n{"b":2}\n{"partial":3}\n')
    for await (const l of streamLines(file, got[1]!.endOffset)) resumed.push(l.line)
    expect(resumed).toEqual(['{"partial":3}'])
  })

  it('handles multi-byte characters split across stream chunks', async () => {
    const file = join(root, 'e.jsonl')
    const text = '{"t":"' + '日本語テキスト🙂'.repeat(200_000) + '"}\n'
    await writeFile(file, text)
    const lines: string[] = []
    for await (const l of streamLines(file)) lines.push(l.line)
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as { t: string }).t.length).toBe(
      '日本語テキスト🙂'.repeat(200_000).length
    )
  })

  it('parseRecord tolerates garbage', () => {
    expect(parseRecord('')).toBeUndefined()
    expect(parseRecord('not json')).toBeUndefined()
    expect(parseRecord('[1,2]')).toBeUndefined()
    expect(parseRecord('{"type":"x"}')).toEqual({ type: 'x' })
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })
})

// --- records -----------------------------------------------------------------

describe('record interpreters', () => {
  it('humanPromptOf ignores injected tags, meta, tool results and compaction digests', () => {
    expect(humanPromptOf(rec.user(S, 'hello', ts(0)))).toBe('hello')
    expect(humanPromptOf(rec.systemReminderUser(S, ts(0)))).toBeUndefined()
    expect(humanPromptOf(rec.user(S, '<command-name>/clear</command-name>', ts(0)))).toBeUndefined()
    expect(humanPromptOf(rec.toolResultUser(S, ts(0)))).toBeUndefined()
    expect(
      humanPromptOf(
        rec.user(S, 'This session is being continued from a previous conversation…', ts(0))
      )
    ).toBeUndefined()
    expect(
      humanPromptOf(rec.user(S, 'real <system-reminder>x</system-reminder> prompt', ts(0)))
    ).toBe('real  prompt')
  })

  it('previewOf strips markdown and keeps the tail', () => {
    const long = 'word '.repeat(100) + 'THE END'
    const p = previewOf(rec.assistant(S, `# Title\n\n- ${long}`, ts(0)))
    expect(p?.endsWith('THE END')).toBe(true)
    expect(p?.startsWith('…')).toBe(true)
    expect(p!.length).toBeLessThanOrEqual(280)
    expect(p).toMatch(/^…word /) // clipped on a word boundary, not mid-word
    expect(stripMarkdown('**bold** `code` [link](http://x) ```\nblock\n``` | t |')).toBe(
      'bold code link t'
    )
  })

  it('applyRecord accumulates every field from an ordinary session', () => {
    const entry = newEntry('/tmp/x/aaaa.jsonl', 1, 1)
    for (const r of ordinarySession(S)) applyRecord(entry, r as Record<string, unknown>)
    expect(entry.cwd).toBe('/Users/test/projects/demo')
    expect(entry.entrypoint).toBe('claude-vscode')
    expect(entry.gitBranches).toEqual(['main'])
    expect(entry.aiTitle).toBe('Fix login bug and ship')
    expect(entry.customTitle).toBeNull()
    expect(entry.firstPrompt).toBe('Please fix the login bug')
    expect(entry.lastPrompt).toBe('Ship it')
    expect(entry.preview).toBe('Shipped as PR #42.')
    expect(entry.userTurns).toBe(3) // digest and tool results excluded
    expect(entry.messageCount).toBe(8) // 3 prompts + 3 replies + 1 tool result + 1 digest; meta excluded
    expect(entry.toolUses).toBe(3)
    expect(entry.compactions).toBe(1)
    expect(entry.tokens.output).toBe(50 + 70 + 20)
    expect(entry.tokens.cacheRead).toBe(3000)
    expect(entry.models).toEqual(['claude-opus-5'])
    expect(entry.prLinks).toEqual([
      { number: 42, url: 'https://github.com/acme/demo/pull/42', repo: 'acme/demo' },
    ])
    expect(entry.createdAt).toBe(ts(0))
    expect(entry.lastActiveAt).toBe(ts(8))
    expect(resolveTitle(entry)).toBe('Fix login bug and ship')
  })

  it('a custom title beats the ai title regardless of order', () => {
    const entry = newEntry('/tmp/x/aaaa.jsonl', 1, 1)
    applyRecord(entry, rec.customTitle(S, 'My name'))
    applyRecord(entry, rec.aiTitle(S, 'Generated later'))
    expect(resolveTitle(entry)).toBe('My name')
    const bare = newEntry('/tmp/x/bbbb.jsonl', 1, 1)
    expect(resolveTitle(bare)).toBe('Untitled session')
    bare.firstPrompt = 'x'.repeat(100)
    expect(resolveTitle(bare)).toHaveLength(80)
  })

  it('synthetic models and unknown record types are ignored', () => {
    const entry = newEntry('/tmp/x/aaaa.jsonl', 1, 1)
    applyRecord(entry, rec.assistant(S, 'compacted', ts(0), { model: '<synthetic>' }))
    applyRecord(entry, { type: 'brand-new-thing', whatever: 1 })
    expect(entry.models).toEqual([])
    expect(entry.messageCount).toBe(1)
  })
})

// --- tiers -------------------------------------------------------------------

describe('tiers', () => {
  it('fast tier on a small file is already complete', async () => {
    const file = await writeSession(
      root,
      '-Users-test-projects-demo',
      S.sessionId,
      ordinarySession(S)
    )
    const { entry } = await fastTier(file)
    expect(entry.fast).toBe(false)
    expect(entry.slug).toBe('-Users-test-projects-demo')
    expect(entry.sessionId).toBe(S.sessionId)
    expect(entry.aiTitle).toBe('Fix login bug and ship')
    expect(entry.tokens.output).toBe(140)
  })

  it('fast tier on a big file reads head and tail only, then the full pass fills counts', async () => {
    const file = await writeSession(root, 'slug', S.sessionId, bigSession(S, 400, 8192))
    const size = (await stat(file)).size
    const fast = await fastTier(file)
    expect(fast.entry.fast).toBe(true)
    expect(fast.bytesRead).toBeLessThan(size / 2)
    expect(fast.entry.firstPrompt).toBe('Start the long task')
    expect(fast.entry.aiTitle).toBe('Long task 380')
    expect(fast.entry.preview).toBe('Step 399 done.')
    expect(fast.entry.lastActiveAt).toBe(ts(400))

    const full = await fullTier(fast.entry)
    expect(full.restarted).toBe(true)
    expect(full.bytesRead).toBe(size)
    expect(full.entry.fast).toBe(false)
    expect(full.entry.parsedTo).toBe(size)
    expect(full.entry.toolUses).toBe(400)
    expect(full.entry.messageCount).toBe(801)
    expect(full.entry.userTurns).toBe(1)

    // Append: the resumed pass reads only the appended bytes.
    await appendRecords(file, [
      rec.user(S, 'one more', ts(500)),
      rec.assistant(S, 'Last.', ts(501), { tools: 1 }),
    ])
    const grown = (await stat(file)).size
    const resumed = await fullTier(full.entry)
    expect(resumed.restarted).toBe(false)
    expect(resumed.bytesRead).toBe(grown - size)
    expect(resumed.entry.toolUses).toBe(401)
    expect(resumed.entry.userTurns).toBe(2)
    expect(resumed.entry.preview).toBe('Last.')
    expect(resumed.entry.lastActiveAt).toBe(ts(501))
  })

  it('a truncated file restarts the full pass from zero', async () => {
    const file = await writeSession(root, 'slug', S.sessionId, bigSession(S, 50))
    const first = await fullTier((await fastTier(file)).entry)
    await writeFile(file, toJsonl(bigSession(S, 5)))
    const again = await fullTier(first.entry)
    expect(again.restarted).toBe(true)
    expect(again.entry.toolUses).toBe(5)
  })

  it('malformed lines are counted, never fatal', async () => {
    const file = await writeSession(root, 'slug', S.sessionId, ordinarySession(S))
    await writeFile(file, (await readFile(file, 'utf8')) + 'this is not json\n{"type":"user"\n')
    const { entry } = await fastTier(file)
    expect(entry.parseErrors).toBe(2)
    expect(entry.aiTitle).toBe('Fix login bug and ship')
  })
})

// --- live sessions --------------------------------------------------------------

describe('live sessions', () => {
  it('parses the pid file shape and drops dead pids', async () => {
    const dir = join(root, 'sessions')
    await writeSession(dir, '.', 'ignored', [])
    await writeFile(
      join(dir, '11080.json'),
      JSON.stringify({
        pid: 11080,
        sessionId: 'live-1',
        cwd: '/w',
        name: 'demo-56',
        startedAt: 1,
        updatedAt: 5,
        entrypoint: 'claude-vscode',
        kind: 'interactive',
      })
    )
    await writeFile(
      join(dir, '999.json'),
      JSON.stringify({ pid: 999, sessionId: 'dead-1', cwd: '/w', updatedAt: 9 })
    )
    await writeFile(join(dir, 'junk.json'), 'nope')
    const live = await readLiveSessions(dir, (pid) => pid === 11080)
    expect(live.map((l) => l.sessionId)).toEqual(['live-1'])
    expect(live[0]?.name).toBe('demo-56')
    expect(parseLiveSession('{"pid":"x"}')).toBeUndefined()
    expect(await readLiveSessions(join(root, 'missing'))).toEqual([])
  })

  it('isProcessAlive treats EPERM as alive and ESRCH as dead', () => {
    const throwing = (code: string) => () => {
      throw Object.assign(new Error(code), { code })
    }
    expect(isProcessAlive(1, () => undefined)).toBe(true)
    expect(isProcessAlive(1, throwing('EPERM'))).toBe(true)
    expect(isProcessAlive(1, throwing('ESRCH'))).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
  })
})

// --- cache -------------------------------------------------------------------

describe('index cache', () => {
  it('round-trips and rejects corrupt or foreign versions', async () => {
    const path = join(root, 'cache', 'index.json')
    const entry = newEntry('/x/y.jsonl', 10, 20)
    await saveIndexCache(path, new Map([[entry.sessionId, entry]]))
    const loaded = await loadIndexCache(path)
    expect(loaded.get('y')).toEqual(entry)
    await writeFile(path, '{"version":99,"sessions":{}}')
    expect((await loadIndexCache(path)).size).toBe(0)
    await writeFile(path, 'garbage')
    expect((await loadIndexCache(path)).size).toBe(0)
    expect((await loadIndexCache(join(root, 'nope.json'))).size).toBe(0)
  })
})

// --- indexer -------------------------------------------------------------------

describe('SessionIndexer', () => {
  function make(overrides: Partial<ConstructorParameters<typeof SessionIndexer>[0]> = {}) {
    return new SessionIndexer({
      projectsDir: join(root, 'projects'),
      sessionsDir: join(root, 'sessions'),
      cachePath: join(root, 'cache', 'index.json'),
      fullTierMaxBytes: 512 * 1024 * 1024,
      wantsFullTier: (e) => e.entrypoint !== 'sdk-cli',
      ...overrides,
    })
  }

  it('cold start indexes every file; a second start re-reads zero bytes', async () => {
    const projects = join(root, 'projects')
    await writeSession(projects, 'slug-a', 'a1', ordinarySession({ sessionId: 'a1' }))
    await writeSession(projects, 'slug-b', 'b1', bigSession({ sessionId: 'b1' }, 300))
    await writeSession(
      projects,
      'slug-b',
      'sdk1',
      ordinarySession({ sessionId: 'sdk1', entrypoint: 'sdk-cli' })
    )
    const first = make()
    await first.start()
    expect(first.status().total).toBe(3)
    expect(first.status().lastScanBytesRead).toBeGreaterThan(0)
    await first.whenIdle()
    const status = first.status()
    expect(status.complete).toBe(3) // a1 + sdk1 were complete from the head; b1 got its full pass
    expect(first.get('b1')?.toolUses).toBe(300)
    await first.flush()
    await first.dispose()

    const second = make()
    await second.start()
    expect(second.status().total).toBe(3)
    expect(second.status().lastScanBytesRead).toBe(0)
    expect(second.get('b1')?.toolUses).toBe(300)
    await second.dispose()
  })

  it('hidden producers stay fast-tier and are not queued for the full pass', async () => {
    const projects = join(root, 'projects')
    await writeSession(
      projects,
      'slug',
      'sdk1',
      bigSession({ sessionId: 'sdk1', entrypoint: 'sdk-cli' }, 300)
    )
    const idx = make()
    await idx.start()
    await idx.whenIdle()
    expect(idx.get('sdk1')?.fast).toBe(true)
    expect(idx.status().fastOnly).toBe(1)
    expect(idx.status().pending).toBe(0)
    await idx.dispose()
  })

  it('an appended file re-parses only the appended bytes and notifies', async () => {
    const projects = join(root, 'projects')
    const file = await writeSession(projects, 'slug', 'b1', bigSession({ sessionId: 'b1' }, 300))
    const idx = make()
    await idx.start()
    await idx.whenIdle()
    const before = (await stat(file)).size
    const changed: string[][] = []
    idx.onDidChange((ids) => changed.push(ids))
    await appendRecords(file, [
      rec.user({ sessionId: 'b1' }, 'again', ts(900)),
      rec.aiTitle({ sessionId: 'b1' }, 'Renamed by AI'),
    ])
    await idx.refresh()
    await idx.whenIdle()
    const entry = idx.get('b1')!
    expect(entry.parsedTo).toBe((await stat(file)).size)
    expect(entry.aiTitle).toBe('Renamed by AI')
    expect(entry.userTurns).toBe(2)
    expect(entry.lastActiveAt).toBe(ts(900))
    // The scan's fast tier read the head+tail; that is bounded and far below the file size.
    expect(idx.status().lastScanBytesRead).toBeLessThan(before)
    await new Promise((r) => setTimeout(r, 150))
    expect(changed.flat()).toContain('b1')
    await idx.dispose()
  })

  it('a deleted file becomes missing, and comes back when restored', async () => {
    const projects = join(root, 'projects')
    const records = ordinarySession({ sessionId: 'a1' })
    const file = await writeSession(projects, 'slug', 'a1', records)
    const idx = make()
    await idx.start()
    await unlink(file)
    await idx.refresh()
    expect(idx.get('a1')?.missing).toBe(true)
    expect(idx.status().missing).toBe(1)
    await writeSession(projects, 'slug', 'a1', records)
    await idx.refresh()
    expect(idx.get('a1')?.missing).toBe(false)
    await idx.dispose()
  })

  it('a targeted path scan indexes only that file, and a deleted path becomes missing', async () => {
    const projects = join(root, 'projects')
    const a = await writeSession(projects, 'slug', 'a1', ordinarySession({ sessionId: 'a1' }))
    const b = await writeSession(projects, 'slug', 'b1', ordinarySession({ sessionId: 'b1' }))
    const idx = make()
    await idx.start()
    await idx.whenIdle()
    await appendRecords(a, [rec.aiTitle({ sessionId: 'a1' }, 'Changed A')])
    await appendRecords(b, [rec.aiTitle({ sessionId: 'b1' }, 'Changed B')])
    await idx.refreshPaths([a])
    await idx.whenIdle()
    expect(idx.get('a1')?.aiTitle).toBe('Changed A')
    expect(idx.get('b1')?.aiTitle).toBe('Fix login bug and ship') // untouched by a targeted scan
    await unlink(b)
    await idx.refreshPaths([b])
    expect(idx.get('b1')?.missing).toBe(true)
    await idx.dispose()
  })

  it('a scan requested mid-scan runs afterwards instead of being dropped', async () => {
    const projects = join(root, 'projects')
    const a = await writeSession(projects, 'slug', 'a1', ordinarySession({ sessionId: 'a1' }))
    const idx = make()
    await idx.start()
    await appendRecords(a, [rec.aiTitle({ sessionId: 'a1' }, 'Second')])
    const first = idx.refresh()
    const second = idx.refresh() // returns immediately, queued behind `first`
    await Promise.all([first, second])
    await idx.whenIdle()
    expect(idx.get('a1')?.aiTitle).toBe('Second')
    await idx.dispose()
  })

  it('files above the size cap stay fast-tier with approximate counts', async () => {
    const projects = join(root, 'projects')
    await writeSession(projects, 'slug', 'b1', bigSession({ sessionId: 'b1' }, 300))
    const idx = make({ fullTierMaxBytes: 1024 })
    await idx.start()
    await idx.whenIdle()
    expect(idx.get('b1')?.fast).toBe(true)
    expect(idx.status().fastOnly).toBe(1)
    await idx.dispose()
  })

  it('a missing projects dir is an empty index, not an error', async () => {
    const idx = make({ projectsDir: join(root, 'nowhere') })
    await idx.start()
    expect(idx.status().total).toBe(0)
    await idx.dispose()
  })

  it('reindex drops everything and rebuilds', async () => {
    const projects = join(root, 'projects')
    await writeSession(projects, 'slug', 'a1', ordinarySession({ sessionId: 'a1' }))
    const idx = make()
    await idx.start()
    await idx.reindex()
    expect(idx.status().total).toBe(1)
    expect(idx.status().lastScanBytesRead).toBeGreaterThan(0)
    await idx.dispose()
  })
})
