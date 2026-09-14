import { parseRecord, readTailLines } from '../index/jsonl'
import type { Rec } from '../index/records'
import { isConversational, recordType, resolveTitle, textOf } from '../index/records'
import { formatCount } from '../index/stats'
import type { SessionIndexEntry } from '../index/types'

/**
 * Turn a transcript's tail into the text the reviewer reads (spec §9.4).
 * Tail-first: where work stands lives in the recent turns (Chat Review D9).
 * Tool calls become one-line markers; tool results a size note (plus a
 * snippet when they look like an error); thinking is dropped; the latest
 * compaction digest is kept in full because it already summarises everything
 * before it. Everything is capped, dropping from the FRONT.
 */
export const TRANSCRIPT_CAP = 48_000
export const DEFAULT_TURNS = 80
const TAIL_MAX_BYTES = 24 * 1024 * 1024
const DIGEST_SEARCH_BYTES = 4 * 1024 * 1024
const TOOL_INPUT_CHARS = 120
const RESULT_SNIPPET_CHARS = 200
const ERROR_HINT = /error|traceback|fail|exception|denied/i
const DIGEST_PREFIX = 'This session is being continued from a previous conversation'
const SYSTEM_TAG = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export interface Transcript {
  text: string
  /** Conversational records included. 0 means the session is empty. */
  turns: number
}

export async function buildTranscript(
  entry: SessionIndexEntry,
  opts: { turns?: number; cap?: number } = {}
): Promise<Transcript> {
  const wanted = opts.turns ?? DEFAULT_TURNS
  const cap = opts.cap ?? TRANSCRIPT_CAP
  // Grow the tail until it holds enough turns AND the newest compaction
  // digest (the cheapest history there is) — or until the digest search
  // budget is spent, in which case the turns alone will do.
  const tail = await readTailLines(entry.filePath, {
    maxBytes: TAIL_MAX_BYTES,
    startBytes: 256 * 1024,
    enough: (lines) => {
      if (countTurns(lines) < wanted) return false
      if (lines.some((l) => l.includes(DIGEST_PREFIX))) return true
      let bytes = 0
      for (const l of lines) bytes += l.length + 1
      return bytes >= DIGEST_SEARCH_BYTES
    },
  })
  const recs: Rec[] = []
  for (const line of tail.lines) {
    const rec = parseRecord(line)
    if (rec) recs.push(rec)
  }
  const conversational = recs.filter(isConversational)
  const kept = conversational.slice(-wanted)
  const body = kept.map(renderRecord).filter(Boolean)
  // The newest compaction digest, if it fell outside the kept window, still
  // goes on top: it is the curated history of everything before it.
  const digest = [...conversational].reverse().find((r) => textOf(r).startsWith(DIGEST_PREFIX))
  const parts: string[] = [header(entry)]
  if (digest && !kept.includes(digest))
    parts.push(`[earlier history, as compacted by the agent]\n${textOf(digest)}`)
  parts.push(...body)
  const text = capFromFront(parts.join('\n\n'), cap)
  return { text, turns: kept.length }
}

export function renderRecord(rec: Rec): string {
  const type = recordType(rec)
  const content = (rec['message'] as Rec | undefined)?.['content']
  if (type === 'user') {
    const text = textOf(rec).replace(SYSTEM_TAG, '').trim()
    const results = Array.isArray(content)
      ? content.filter((b) => isBlock(b) && b['type'] === 'tool_result')
      : []
    const lines: string[] = []
    if (text && !text.startsWith('<')) lines.push(`USER: ${text}`)
    for (const r of results) {
      const body = resultText(r as Rec)
      const note = `[result: ${formatCount(body.length)} chars]`
      lines.push(
        ERROR_HINT.test(body)
          ? `${note} ${body.slice(0, RESULT_SNIPPET_CHARS).replace(/\s+/g, ' ')}`
          : note
      )
    }
    return lines.join('\n')
  }
  if (type === 'assistant') {
    const lines: string[] = []
    const text = textOf(rec).trim()
    if (text) lines.push(`ASSISTANT: ${text}`)
    if (Array.isArray(content)) {
      for (const b of content) {
        if (isBlock(b) && b['type'] === 'tool_use') {
          const name = typeof b['name'] === 'string' ? b['name'] : 'tool'
          lines.push(`[tool: ${name} — ${summarizeInput(b['input'])}]`)
        }
      }
    }
    return lines.join('\n')
  }
  return ''
}

export function header(entry: SessionIndexEntry): string {
  const lines = [
    'SESSION',
    `title: ${resolveTitle(entry)}`,
    `project: ${entry.cwd || entry.slug}`,
    `branches: ${entry.gitBranches.join(', ') || 'unknown'}`,
    `pull requests: ${entry.prLinks.map((p) => `#${p.number} ${p.url}`).join(', ') || 'none'}`,
    `turns: ${entry.userTurns} · tool calls: ${entry.toolUses} · output tokens: ${formatCount(entry.tokens.output)}`,
    `first active: ${entry.createdAt} · last active: ${entry.lastActiveAt}`,
  ]
  return lines.join('\n')
}

export function capFromFront(text: string, cap: number): string {
  if (text.length <= cap) return text
  const cut = text.slice(text.length - cap)
  const nl = cut.indexOf('\n')
  return `[…earlier turns omitted…]\n${nl > 0 && nl < 400 ? cut.slice(nl + 1) : cut}`
}

function countTurns(lines: string[]): number {
  let n = 0
  for (const line of lines) {
    const rec = parseRecord(line)
    if (rec && isConversational(rec)) n++
  }
  return n
}

function isBlock(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null
}

function resultText(block: Rec): string {
  const c = block['content']
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b) => (isBlock(b) && typeof b['text'] === 'string' ? b['text'] : '')).join('\n')
  }
  return ''
}

function summarizeInput(input: unknown): string {
  let s: string
  if (typeof input === 'string') s = input
  else if (isBlock(input)) {
    // Prefer the field a human would read: a command, a path, a query.
    const key = [
      'command',
      'file_path',
      'path',
      'query',
      'pattern',
      'url',
      'description',
      'prompt',
    ].find((k) => typeof input[k] === 'string')
    s = key ? `${key}=${String(input[key])}` : JSON.stringify(input)
  } else s = input === undefined || input === null ? '' : JSON.stringify(input)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > TOOL_INPUT_CHARS ? `${s.slice(0, TOOL_INPUT_CHARS - 1)}…` : s
}
