import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { parseRecord, readHeadLines, readTailLines, streamLines } from './jsonl'
import type { Rec } from './records'
import { applyRecord, humanPromptOf, previewOf, recordType, timestampOf } from './records'
import type { SessionIndexEntry } from './types'
import { emptyTokens } from './types'

/**
 * The two indexing tiers (spec §5).
 *
 * Fast tier: head + tail of the file, enough to render a card. Runs on every
 * refresh for every changed file; must stay cheap.
 *
 * Full tier: a streaming pass from `parsedTo` to EOF that fills in counts,
 * tokens, models and PR links. Resumable because the file is append-only.
 */

export const HEAD_MAX_BYTES = 1024 * 1024
export const TAIL_MAX_BYTES = 4 * 1024 * 1024

export function newEntry(filePath: string, size: number, mtimeMs: number): SessionIndexEntry {
  return {
    sessionId: basename(filePath, '.jsonl'),
    slug: basename(dirname(filePath)),
    filePath,
    cwd: '',
    gitBranches: [],
    entrypoint: '',
    version: '',
    customTitle: null,
    aiTitle: null,
    firstPrompt: '',
    lastPrompt: null,
    preview: null,
    createdAt: '',
    lastActiveAt: '',
    messageCount: 0,
    userTurns: 0,
    toolUses: 0,
    compactions: 0,
    tokens: emptyTokens(),
    models: [],
    prLinks: [],
    size,
    mtimeMs,
    parsedTo: 0,
    fast: true,
    parseErrors: 0,
    missing: false,
  }
}

function records(lines: string[]): { recs: Rec[]; errors: number } {
  const recs: Rec[] = []
  let errors = 0
  for (const line of lines) {
    const rec = parseRecord(line)
    if (rec) recs.push(rec)
    else if (line.trim()) errors++
  }
  return { recs, errors }
}

const headSatisfied = (lines: string[]): boolean => {
  let sawTurn = false
  for (const line of lines) {
    const rec = parseRecord(line)
    if (!rec) continue
    const type = recordType(rec)
    if (type === 'user' || type === 'assistant') sawTurn = true
    if (humanPromptOf(rec)) return true
  }
  // A file with turns but no human prompt yet (an SDK run) is still "known".
  return sawTurn && lines.length >= 40
}

const tailSatisfied = (lines: string[]): boolean => {
  let sawTimestamp = false
  let sawPreview = false
  let sawTitle = false
  for (const line of lines) {
    const rec = parseRecord(line)
    if (!rec) continue
    if (timestampOf(rec)) sawTimestamp = true
    if (previewOf(rec)) sawPreview = true
    const type = recordType(rec)
    if (type === 'ai-title' || type === 'custom-title') sawTitle = true
  }
  return sawTimestamp && sawPreview && sawTitle
}

export interface FastResult {
  entry: SessionIndexEntry
  bytesRead: number
}

/**
 * Build a renderable entry from the file's head and tail. Counts and tokens
 * only cover the lines seen, so `fast` stays true until the full pass runs.
 */
export async function fastTier(filePath: string): Promise<FastResult> {
  const st = await stat(filePath)
  const entry = newEntry(filePath, st.size, st.mtimeMs)
  const head = await readHeadLines(filePath, { maxBytes: HEAD_MAX_BYTES, enough: headSatisfied })
  let bytesRead = head.bytesRead
  const headRecords = records(head.lines)
  entry.parseErrors += headRecords.errors
  for (const rec of headRecords.recs) applyRecord(entry, rec)

  if (!head.complete) {
    const tail = await readTailLines(filePath, { maxBytes: TAIL_MAX_BYTES, enough: tailSatisfied })
    bytesRead += tail.bytesRead
    // Tail lines are applied on a scratch entry so counts are not double
    // counted where head and tail overlap; only "latest wins" fields carry over.
    const scratch = newEntry(filePath, st.size, st.mtimeMs)
    const tailRecords = records(tail.lines)
    for (const rec of tailRecords.recs) applyRecord(scratch, rec)
    if (scratch.lastActiveAt > entry.lastActiveAt) entry.lastActiveAt = scratch.lastActiveAt
    if (scratch.preview) entry.preview = scratch.preview
    if (scratch.lastPrompt) entry.lastPrompt = scratch.lastPrompt
    if (scratch.aiTitle) entry.aiTitle = scratch.aiTitle
    if (scratch.customTitle) entry.customTitle = scratch.customTitle
    if (scratch.version) entry.version = scratch.version
    for (const b of scratch.gitBranches)
      if (!entry.gitBranches.includes(b)) entry.gitBranches.push(b)
    for (const p of scratch.prLinks)
      if (!entry.prLinks.some((x) => x.url === p.url)) entry.prLinks.push(p)
    if (!entry.cwd) entry.cwd = scratch.cwd
    if (!entry.entrypoint) entry.entrypoint = scratch.entrypoint
  } else {
    // The head covered the whole file: this IS the full pass.
    entry.parsedTo = st.size
    entry.fast = false
  }
  if (!entry.createdAt) entry.createdAt = new Date(st.birthtimeMs || st.mtimeMs).toISOString()
  if (!entry.lastActiveAt) entry.lastActiveAt = new Date(st.mtimeMs).toISOString()
  return { entry, bytesRead }
}

export interface FullResult {
  entry: SessionIndexEntry
  bytesRead: number
  /** True when the pass restarted from 0 because the file shrank or was replaced. */
  restarted: boolean
}

/**
 * Stream every newline-terminated line from `entry.parsedTo`. When resuming
 * an entry that already had a full pass, counts continue from where they
 * were; when starting from 0, counts are reset first so a fast-tier entry's
 * partial numbers are not added to.
 */
export async function fullTier(
  previous: SessionIndexEntry,
  signal?: AbortSignal
): Promise<FullResult> {
  const st = await stat(previous.filePath)
  const restart = previous.fast || previous.parsedTo > st.size || previous.parsedTo === 0
  const entry: SessionIndexEntry = restart
    ? {
        ...newEntry(previous.filePath, st.size, st.mtimeMs),
        // Title/preview from the fast tier are kept as a floor; the stream will
        // overwrite them with whatever it sees later in the file.
        customTitle: previous.customTitle,
        aiTitle: previous.aiTitle,
        preview: previous.preview,
        lastPrompt: previous.lastPrompt,
      }
    : {
        ...previous,
        tokens: { ...previous.tokens },
        gitBranches: [...previous.gitBranches],
        models: [...previous.models],
        prLinks: [...previous.prLinks],
      }
  const from = restart ? 0 : previous.parsedTo
  let consumed = from
  let lines = 0
  for await (const { line, endOffset } of streamLines(previous.filePath, from)) {
    if (signal?.aborted) break
    const rec = parseRecord(line)
    if (rec) applyRecord(entry, rec)
    else if (line.trim()) entry.parseErrors++
    consumed = endOffset
    if (++lines % 2000 === 0) await new Promise((r) => setImmediate(r))
  }
  entry.parsedTo = consumed
  entry.size = st.size
  entry.mtimeMs = st.mtimeMs
  entry.fast = false
  if (!entry.createdAt)
    entry.createdAt = previous.createdAt || new Date(st.birthtimeMs || st.mtimeMs).toISOString()
  if (!entry.lastActiveAt)
    entry.lastActiveAt = previous.lastActiveAt || new Date(st.mtimeMs).toISOString()
  return { entry, bytesRead: consumed - from, restarted: restart }
}
