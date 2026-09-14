import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'

/**
 * Byte-level readers for append-only JSONL. Three access patterns, all cheap:
 *
 *  - readHeadLines: the first complete lines, growing the read until the caller
 *    is satisfied or the cap is hit
 *  - readTailLines: the last complete lines, same growth strategy from the end
 *  - streamLines: every newline-terminated line from a byte offset — the
 *    resumable full pass. A trailing partial line is not yielded; its offset is
 *    not consumed, so a mid-write tail is simply picked up next time.
 */

const NEWLINE = 0x0a

export interface LineChunk {
  lines: string[]
  /** Bytes actually read. */
  bytesRead: number
  /** True when the read covered the whole file (head and tail overlap). */
  complete: boolean
}

export async function readHeadLines(
  path: string,
  opts: { maxBytes: number; startBytes?: number; enough?: (lines: string[]) => boolean }
): Promise<LineChunk> {
  const size = (await stat(path)).size
  const handle = await open(path, 'r')
  try {
    let length = Math.min(opts.startBytes ?? 16 * 1024, opts.maxBytes, size)
    for (;;) {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      const complete = bytesRead >= size
      let text = buffer.subarray(0, bytesRead).toString('utf8')
      const lastNewline = text.lastIndexOf('\n')
      if (!complete) text = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1)
      const lines = splitLines(text)
      const satisfied = opts.enough ? opts.enough(lines) : lines.length > 0
      if (complete || satisfied || length >= opts.maxBytes) return { lines, bytesRead, complete }
      length = Math.min(length * 4, opts.maxBytes, size)
    }
  } finally {
    await handle.close()
  }
}

export async function readTailLines(
  path: string,
  opts: { maxBytes: number; startBytes?: number; enough?: (lines: string[]) => boolean }
): Promise<LineChunk> {
  const size = (await stat(path)).size
  const handle = await open(path, 'r')
  try {
    let length = Math.min(opts.startBytes ?? 16 * 1024, opts.maxBytes, size)
    for (;;) {
      const position = size - length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      const complete = position === 0
      let text = buffer.subarray(0, bytesRead).toString('utf8')
      if (!complete) {
        // Drop the leading partial line; a multi-byte char split at `position`
        // also lands in that discarded prefix.
        const firstNewline = text.indexOf('\n')
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }
      const lines = splitLines(text)
      const satisfied = opts.enough ? opts.enough(lines) : lines.length > 0
      if (complete || satisfied || length >= opts.maxBytes) return { lines, bytesRead, complete }
      length = Math.min(length * 4, opts.maxBytes, size)
    }
  } finally {
    await handle.close()
  }
}

export interface StreamedLine {
  line: string
  /** Byte offset just past this line's newline — the resume point after it. */
  endOffset: number
}

export async function* streamLines(path: string, fromOffset = 0): AsyncGenerator<StreamedLine> {
  const stream = createReadStream(path, { start: fromOffset, highWaterMark: 1024 * 1024 })
  let carry: Buffer[] = []
  let carryLength = 0
  let offset = fromOffset
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0
    for (;;) {
      const idx = chunk.indexOf(NEWLINE, start)
      if (idx === -1) break
      const piece = chunk.subarray(start, idx)
      const lineBuffer = carryLength ? Buffer.concat([...carry, piece]) : piece
      carry = []
      carryLength = 0
      offset += idx - start + 1
      yield { line: lineBuffer.toString('utf8'), endOffset: offset }
      start = idx + 1
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      carry.push(rest)
      carryLength += rest.length
      offset += rest.length
    }
  }
  // A trailing partial line is deliberately not yielded (see module doc).
}

export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Parse one JSONL line. Returns undefined for anything that is not a JSON object. */
export function parseRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
