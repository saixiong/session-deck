import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRecord } from '../index/records'
import { bigSession, ordinarySession, rec, ts, writeSession } from '../index/testFixtures'
import { fastTier, newEntry } from '../index/tiers'
import type { SessionIndexEntry } from '../index/types'
import type { BatchProgress } from '../shared/review'
import { cliArgs, parseStdout, type CliResult } from './ClaudeCli'
import { ReviewRunner } from './ReviewRunner'
import { fingerprintOf, parseReviewFile, ReviewStore } from './ReviewStore'
import { emptyReview, makeReview, parseReview, REVIEW_SCHEMA, SYSTEM_PROMPT } from './schema'
import { buildTranscript, capFromFront, renderRecord } from './transcript'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-review-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const S = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

/** The shape recorded from `claude -p --output-format json --json-schema` on 2026-09-14. */
const recorded = (structured: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 3042,
  result: JSON.stringify(structured),
  structured_output: structured,
  total_cost_usd: 0.0029,
  session_id: 'cdd41434-a4c7-4d19-8a6f-b7f90d6de4ea',
  usage: { input_tokens: 931, output_tokens: 282 },
  ...extra,
})

const GOOD = {
  summary: 'Fixing the login bug; PR #42 is open.',
  done: ['Fixed the bug', 'Added a test'],
  next_steps: ['Merge PR #42'],
  blockers: [],
  priority: 4,
  priority_reason: 'A PR is waiting.',
  options: [
    {
      id: 'merge',
      label: 'Merge the PR',
      description: 'Land it.',
      prompt: 'Merge PR #42 and confirm CI.',
    },
    {
      id: 'more-tests',
      label: 'Add more tests',
      description: 'Cover edge cases.',
      prompt: 'Add tests for the logout path.',
    },
  ],
}

describe('schema / parseReview', () => {
  it('prefers structured_output and clamps priority', () => {
    const parsed = parseReview({ ...GOOD, priority: 9 }, undefined)
    expect(parsed.priority).toBe(5)
    expect(parsed.options).toHaveLength(2)
  })

  it('recovers JSON from fenced or prefixed result text', () => {
    const text = 'Sure! Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```'
    expect(parseReview(undefined, text).summary).toBe(GOOD.summary)
    expect(parseReview(undefined, 'preamble ' + JSON.stringify(GOOD) + ' trailing').done).toEqual(
      GOOD.done
    )
  })

  it('drops options without a prompt or label, dedupes ids, caps at 4, and fails with none', () => {
    const parsed = parseReview(
      {
        ...GOOD,
        options: [
          { label: 'A', prompt: 'a' },
          { label: 'A', prompt: 'a2' },
          { label: 'no prompt' },
          { prompt: 'no label' },
          { id: 'c', label: 'C', prompt: 'c' },
          { id: 'd', label: 'D', prompt: 'd' },
          { id: 'e', label: 'E', prompt: 'e' },
        ],
      },
      undefined
    )
    expect(parsed.options.map((o) => o.id)).toEqual(['a', 'a-2', 'c', 'd'])
    expect(() => parseReview({ ...GOOD, options: [] }, undefined)).toThrow(/directions/)
    expect(() => parseReview(undefined, 'nothing here')).toThrow(/no JSON/)
    expect(() => parseReview('a string', 'not json')).toThrow()
  })

  it('makeReview / emptyReview fill the D7 shape', () => {
    const base = {
      conversation_id: 'x',
      title: 't',
      model: 'sonnet',
      fingerprint: '1:2',
      message_count: 1,
      cost_usd: 0.1,
      duration_ms: 5,
    }
    const r = makeReview(base, parseReview(GOOD, undefined), new Date('2026-09-14T00:00:00Z'))
    expect(r.priority_label).toBe('High')
    expect(r.analyzed_at).toBe('2026-09-14T00:00:00.000Z')
    expect(r.error).toBeNull()
    const e = emptyReview(base)
    expect(e.priority).toBe(1)
    expect(e.cost_usd).toBe(0)
    expect(e.options).toHaveLength(1)
    expect(SYSTEM_PROMPT).toContain('SESSION header')
    expect(REVIEW_SCHEMA.required).toContain('options')
  })
})

describe('ClaudeCli helpers', () => {
  it('args isolate the run and never use --bare', () => {
    const args = cliArgs({ systemPrompt: 'sp', schema: { a: 1 }, model: 'sonnet' })
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).not.toContain('--bare')
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"a":1}')
  })

  it('parseStdout tolerates a warning line before the JSON', () => {
    const json = JSON.stringify(recorded(GOOD))
    expect(parseStdout(json)?.['type']).toBe('result')
    expect(parseStdout('Warning: no stdin data received\n' + json)?.['subtype']).toBe('success')
    expect(parseStdout('')).toBeUndefined()
    expect(parseStdout('garbage')).toBeUndefined()
  })
})

describe('transcript', () => {
  it('renders user text, tool markers, result notes with error snippets, and drops thinking', () => {
    expect(renderRecord(rec.user(S, 'hello', ts(0)))).toBe('USER: hello')
    expect(renderRecord(rec.systemReminderUser(S, ts(0)))).toBe('')
    const a = renderRecord(rec.assistant(S, 'On it.', ts(1), { tools: 1, thinking: true }))
    expect(a).toBe('ASSISTANT: On it.\n[tool: Bash — command=ls]')
    expect(renderRecord(rec.toolResultUser(S, ts(2)))).toBe('[result: 2 chars]')
    const failing = {
      ...rec.toolResultUser(S, ts(2)),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't',
            content: 'Traceback (most recent call last): boom',
          },
        ],
      },
    }
    expect(renderRecord(failing)).toMatch(/^\[result: 39 chars\] Traceback/)
  })

  it('builds from the tail, keeps the header first, and includes an out-of-window compaction digest', async () => {
    const file = await writeSession(root, 'slug', S.sessionId, [
      ...ordinarySession(S),
      ...bigSession(S, 120).slice(1), // 120 more turns after the digest
    ])
    const { entry } = await fastTier(file)
    const full = { ...entry, messageCount: 500 }
    const t = await buildTranscript(full, { turns: 20 })
    expect(t.turns).toBe(20)
    expect(t.text.startsWith('SESSION\ntitle: Long task 100')).toBe(true) // the tail's last ai-title wins
    expect(t.text).toContain('pull requests: #42 https://github.com/acme/demo/pull/42')
    expect(t.text).toContain('[earlier history, as compacted by the agent]')
    expect(t.text).toContain('Step 119 done.')
    expect(t.text).not.toContain('Step 10 done.')
  })

  it('an empty session yields zero turns; the cap drops from the front', async () => {
    const file = await writeSession(root, 'slug', S.sessionId, [rec.aiTitle(S, 'Empty')])
    const { entry } = await fastTier(file)
    expect((await buildTranscript(entry)).turns).toBe(0)
    const capped = capFromFront('a'.repeat(100) + '\nKEEP THIS TAIL', 20)
    expect(capped.startsWith('[…earlier turns omitted…]')).toBe(true)
    expect(capped.endsWith('KEEP THIS TAIL')).toBe(true)
  })
})

describe('ReviewStore', () => {
  it('round-trips, refuses failed reviews, and treats corrupt files as misses', async () => {
    const store = new ReviewStore(join(root, 'reviews'))
    await store.load()
    const review = makeReview(
      {
        conversation_id: S.sessionId,
        title: 't',
        model: 'm',
        fingerprint: '1:x',
        message_count: 1,
        cost_usd: 0.01,
        duration_ms: 1,
      },
      parseReview(GOOD, undefined)
    )
    await store.set(review)
    const again = new ReviewStore(join(root, 'reviews'))
    await again.load()
    expect(again.get(S.sessionId)?.summary).toBe(GOOD.summary)
    await expect(store.set({ ...review, error: 'boom' })).rejects.toThrow(/failed/)
    await writeFile(join(root, 'reviews', 'bad.json'), '{not json')
    await writeFile(join(root, 'reviews', '../escape.json'), '{}').catch(() => undefined)
    const third = new ReviewStore(join(root, 'reviews'))
    await third.load()
    expect(third.all().map((r) => r.conversation_id)).toEqual([S.sessionId])
    expect(await store.delete(S.sessionId)).toBe(true)
    expect(await store.delete('../../etc/passwd')).toBe(false)
    expect(parseReviewFile('{"conversation_id":"x","error":"e"}')).toBeUndefined()
    expect(parseReviewFile('{"conversation_id":"x","priority":"high"}')?.priority).toBe(3)
  })
})

describe('ReviewRunner', () => {
  function entryFor(
    id: string,
    opts: { turns?: number; missing?: boolean } = {}
  ): SessionIndexEntry {
    const e = newEntry(`/x/-x/${id}.jsonl`, 1, 1)
    for (const r of ordinarySession({ sessionId: id })) applyRecord(e, r as Record<string, unknown>)
    e.fast = false
    if (opts.missing) e.missing = true
    return e
  }

  function makeRunner(opts: {
    entries: Record<string, SessionIndexEntry>
    call?: (prompt: string, signal: AbortSignal) => Promise<CliResult>
    turns?: (id: string) => number
    concurrency?: number
  }) {
    const store = new ReviewStore(join(root, 'reviews'))
    const calls: string[] = []
    const runner = new ReviewRunner({
      getEntry: (id) => opts.entries[id],
      buildTranscript: (e) =>
        Promise.resolve({
          text: `T:${e.sessionId}`,
          turns: opts.turns ? opts.turns(e.sessionId) : 3,
        }),
      callModel: async ({ prompt, signal }) => {
        calls.push(prompt)
        if (opts.call) return opts.call(prompt, signal)
        const r = recorded(GOOD)
        return {
          ok: true,
          structured: r.structured_output,
          resultText: r.result,
          costUsd: r.total_cost_usd,
          durationMs: r.duration_ms,
          errorText: undefined,
        }
      },
      store,
      model: 'sonnet',
      concurrency: opts.concurrency ?? 2,
    })
    return { runner, store, calls }
  }

  it('reviews a batch, caches results, skips fresh ones next time, forces when asked', async () => {
    const entries = { a: entryFor('a'), b: entryFor('b') }
    const { runner, store, calls } = makeRunner({ entries })
    await store.load()
    const events: BatchProgress[] = []
    runner.onProgress((p) => events.push(p))
    const p = await runner.analyze(['a', 'b', 'a'])
    expect(p.ids).toEqual(['a', 'b'])
    expect(p.done).toBe(2)
    expect(p.running).toBe(false)
    expect(p.cost_usd).toBeCloseTo(0.0058)
    expect(store.get('a')?.fingerprint).toBe(fingerprintOf(entries.a))
    expect(events.some((e) => e.status['a'] === 'running')).toBe(true)
    expect(calls).toHaveLength(2)

    const p2 = await runner.analyze(['a', 'b'])
    expect(p2.ids).toEqual([])
    expect(calls).toHaveLength(2)
    // The transcript grows → stale → re-analysed.
    entries.a.messageCount += 1
    expect(runner.isStale(store.get('a')!, entries.a)).toBe(true)
    await runner.analyze(['a', 'b'])
    expect(calls).toHaveLength(3)
    await runner.analyze(['b'], { force: true })
    expect(calls).toHaveLength(4)
  })

  it('a failed session is reported inline and never cached; the others complete', async () => {
    const entries = {
      a: entryFor('a'),
      b: entryFor('b'),
      gone: entryFor('gone', { missing: true }),
    }
    const { runner, store } = makeRunner({
      entries,
      call: (prompt) =>
        Promise.resolve(
          prompt === 'T:a'
            ? {
                ok: false,
                structured: undefined,
                resultText: 'Not logged in · Please run /login',
                costUsd: null,
                durationMs: null,
                errorText: 'Not logged in · Please run /login',
              }
            : {
                ok: true,
                structured: GOOD,
                resultText: JSON.stringify(GOOD),
                costUsd: 0.01,
                durationMs: 1,
                errorText: undefined,
              }
        ),
    })
    await store.load()
    const p = await runner.analyze(['a', 'b', 'gone', 'unknown'])
    expect(p.status).toEqual({ a: 'failed', b: 'done', gone: 'failed', unknown: 'failed' })
    expect(p.errors['a']).toMatch(/Not logged in/)
    expect(p.errors['gone']).toMatch(/no longer on disk/)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBeDefined()
    const onDisk = await readFile(join(root, 'reviews', 'b.json'), 'utf8')
    expect(JSON.parse(onDisk)).toMatchObject({ conversation_id: 'b', priority: 4 })
  })

  it('an empty session costs no model call', async () => {
    const entries = { e: entryFor('e') }
    const { runner, store, calls } = makeRunner({ entries, turns: () => 0 })
    await store.load()
    await runner.analyze(['e'])
    expect(calls).toHaveLength(0)
    expect(store.get('e')?.priority).toBe(1)
  })

  it('cancel aborts in-flight calls and marks the rest cancelled', async () => {
    const entries = { a: entryFor('a'), b: entryFor('b'), c: entryFor('c') }
    const { runner, store } = makeRunner({
      entries,
      concurrency: 1,
      call: (_prompt, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({
              ok: false,
              structured: undefined,
              resultText: undefined,
              costUsd: null,
              durationMs: null,
              errorText: 'cancelled',
            })
          )
        }),
    })
    await store.load()
    const done = runner.analyze(['a', 'b', 'c'])
    await new Promise((r) => setTimeout(r, 10))
    expect(runner.running).toBe(true)
    runner.cancel()
    const p = await done
    expect(p.cancelled).toBe(true)
    expect(p.status).toEqual({ a: 'cancelled', b: 'cancelled', c: 'cancelled' })
    expect(p.failed).toBe(0)
    expect(runner.running).toBe(false)
  })

  it('refuses a second batch while one runs', async () => {
    const entries = { a: entryFor('a') }
    const { runner, store } = makeRunner({ entries, call: () => new Promise(() => undefined) })
    await store.load()
    const first = runner.analyze(['a'])
    await new Promise((r) => setTimeout(r, 5))
    await expect(runner.analyze(['a'])).rejects.toThrow(/already running/)
    runner.cancel()
    await first
  })
})
