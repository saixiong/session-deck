import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Builders for realistic session records, shaped like the ones observed on
 * 2026-09-14 (spec §3.2). Tests compose these into JSONL files under a temp
 * projects dir so nothing touches the real ~/.claude.
 */

export interface FixtureOptions {
  sessionId: string
  cwd?: string
  entrypoint?: string
  gitBranch?: string
  version?: string
}

const base = (o: FixtureOptions, timestamp: string) => ({
  isSidechain: false,
  timestamp,
  sessionId: o.sessionId,
  cwd: o.cwd ?? '/Users/test/projects/demo',
  entrypoint: o.entrypoint ?? 'claude-vscode',
  gitBranch: o.gitBranch ?? 'main',
  version: o.version ?? '2.1.270',
  userType: 'external',
})

export const rec = {
  user(o: FixtureOptions, text: string, timestamp: string, extra: Record<string, unknown> = {}) {
    return {
      ...base(o, timestamp),
      parentUuid: null,
      type: 'user',
      uuid: `u-${timestamp}`,
      message: { role: 'user', content: text },
      ...extra,
    }
  },
  systemReminderUser(o: FixtureOptions, timestamp: string) {
    return rec.user(o, '<system-reminder>injected</system-reminder>', timestamp, { isMeta: true })
  },
  toolResultUser(o: FixtureOptions, timestamp: string) {
    return {
      ...base(o, timestamp),
      type: 'user',
      uuid: `tr-${timestamp}`,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    }
  },
  assistant(
    o: FixtureOptions,
    text: string,
    timestamp: string,
    opts: {
      tools?: number
      model?: string
      usage?: Record<string, number>
      thinking?: boolean
    } = {}
  ) {
    const content: unknown[] = []
    if (opts.thinking) content.push({ type: 'thinking', thinking: 'hmm' })
    content.push({ type: 'text', text })
    for (let i = 0; i < (opts.tools ?? 0); i++) {
      content.push({ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'ls' } })
    }
    return {
      ...base(o, timestamp),
      type: 'assistant',
      uuid: `a-${timestamp}`,
      requestId: 'req_1',
      message: {
        model: opts.model ?? 'claude-opus-5',
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
          output_tokens: 50,
          ...opts.usage,
        },
      },
    }
  },
  aiTitle(o: FixtureOptions, title: string) {
    return { type: 'ai-title', aiTitle: title, sessionId: o.sessionId }
  },
  customTitle(o: FixtureOptions, title: string) {
    return { type: 'custom-title', customTitle: title, sessionId: o.sessionId }
  },
  lastPrompt(o: FixtureOptions, prompt: string) {
    return { type: 'last-prompt', lastPrompt: prompt, leafUuid: 'leaf', sessionId: o.sessionId }
  },
  prLink(o: FixtureOptions, number: number, timestamp: string) {
    return {
      type: 'pr-link',
      sessionId: o.sessionId,
      prNumber: number,
      prUrl: `https://github.com/acme/demo/pull/${number}`,
      prRepository: 'acme/demo',
      timestamp,
    }
  },
  compactBoundary(o: FixtureOptions, timestamp: string) {
    return {
      ...base(o, timestamp),
      parentUuid: null,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      uuid: `c-${timestamp}`,
      level: 'info',
      compactMetadata: { trigger: 'manual', preTokens: 696006, durationMs: 1000 },
    }
  },
  summary(text: string) {
    return { type: 'summary', leafUuid: 'leaf', summary: text }
  },
  noise(o: FixtureOptions) {
    return [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-09-09T14:30:42.103Z',
        sessionId: o.sessionId,
      },
      { type: 'mode', mode: 'normal', sessionId: o.sessionId },
      { type: 'atis-latch', atis: 'deadbeef', sessionId: o.sessionId },
      {
        type: 'bridge-session',
        sessionId: o.sessionId,
        bridgeSessionId: 'cse_1',
        lastSequenceNum: 0,
      },
      { type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false },
      { type: 'some-future-record', payload: { anything: true } },
    ]
  },
}

export function ts(minuteOffset: number, day = '2026-09-10'): string {
  const d = new Date(`${day}T10:00:00.000Z`)
  d.setMinutes(d.getMinutes() + minuteOffset)
  return d.toISOString()
}

export const toJsonl = (records: unknown[]): string =>
  records.map((r) => JSON.stringify(r)).join('\n') + '\n'

/** A complete, ordinary session: 3 turns, title, PR link, one compaction. */
export function ordinarySession(o: FixtureOptions): unknown[] {
  return [
    ...rec.noise(o),
    rec.user(o, 'Please fix the login bug', ts(0)),
    rec.systemReminderUser(o, ts(0)),
    rec.assistant(o, 'Looking at it now.', ts(1), { tools: 2 }),
    rec.toolResultUser(o, ts(2)),
    rec.aiTitle(o, 'Fix login bug'),
    rec.user(o, 'Also add a test', ts(3)),
    rec.assistant(o, '## Done\n\nAdded `test_login` and it **passes**.', ts(4), {
      tools: 1,
      usage: { output_tokens: 70 },
    }),
    rec.prLink(o, 42, ts(5)),
    rec.compactBoundary(o, ts(6)),
    rec.user(
      o,
      'This session is being continued from a previous conversation that ran out of context. Summary: ...',
      ts(6)
    ),
    rec.summary('Login bug fix'),
    rec.user(o, 'Ship it', ts(7)),
    rec.assistant(o, 'Shipped as PR #42.', ts(8), { usage: { output_tokens: 20 } }),
    rec.lastPrompt(o, 'Ship it'),
    rec.aiTitle(o, 'Fix login bug and ship'),
  ]
}

export async function writeSession(
  projectsDir: string,
  slug: string,
  sessionId: string,
  records: unknown[]
): Promise<string> {
  const dir = join(projectsDir, slug)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  await writeFile(file, toJsonl(records), 'utf8')
  return file
}

export async function appendRecords(file: string, records: unknown[]): Promise<void> {
  await appendFile(file, toJsonl(records), 'utf8')
}

/**
 * A big session for the resumable-pass tests: `turns` user/assistant pairs
 * with a chunky tool result each, so the file has long lines like real ones.
 */
export function bigSession(o: FixtureOptions, turns: number, payloadBytes = 4096): unknown[] {
  const out: unknown[] = [rec.user(o, 'Start the long task', ts(0))]
  const payload = 'x'.repeat(payloadBytes)
  for (let i = 0; i < turns; i++) {
    out.push(rec.assistant(o, `Step ${i} done.`, ts(i + 1), { tools: 1 }))
    out.push({
      ...rec.toolResultUser(o, ts(i + 1)),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: payload }],
      },
    })
    if (i % 20 === 0) out.push(rec.aiTitle(o, `Long task ${i}`))
  }
  return out
}
