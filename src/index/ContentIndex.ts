import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isConversational, textOf } from './records'
import { parseRecord, streamLines } from './jsonl'
import type { SessionIndexEntry } from './types'
import { writeFileAtomic } from '../util/atomicWrite'

/**
 * The transcript-content index (SPEC_SEARCH S6): what a session *said*, so a
 * word buried in its middle can be found. Measured on the real corpus before
 * this was designed: 727 MB of JSONL holds 25.6 MB of conversational text
 * in 28k messages with a 56k-word vocabulary — small enough that a plain
 * substring scan of an in-memory lowercase copy answers a query in tens of
 * milliseconds, and an inverted index would be machinery for its own sake.
 *
 * On disk: `<dir>/<sessionId>.txt`, user and assistant text only, one
 * message per line, appended from the session's byte offset in
 * `<dir>/manifest.json` — incremental like the index itself (D8). A file
 * that shrank or moved is rebuilt from zero. Nothing here ever writes under
 * `~/.claude` (D5). In memory: the lowercase text per session, for matching;
 * a snippet reads the original-case file.
 */

export interface ContentHit {
  /** 120 characters of original text around the first occurrence, newlines collapsed. */
  snippet: string
}

interface ManifestEntry {
  /** Byte offset of the transcript consumed so far. */
  to: number
  /** Transcript size at that point — a smaller file now means a rebuild. */
  size: number
}

interface Manifest {
  version: 1
  sessions: Record<string, ManifestEntry>
}

export const SNIPPET_CHARS = 120
const MANIFEST = 'manifest.json'
/** Lines yielded per event-loop turn while catching up; keeps the host responsive. */
const YIELD_EVERY = 500

export interface ContentIndexOptions {
  dir: string
  log?: (message: string) => void
}

export class ContentIndex {
  private readonly texts = new Map<string, string>()
  private manifest: Manifest = { version: 1, sessions: {} }
  private loaded = false
  private saving: Promise<void> | undefined
  private manifestDirty = false
  private running: Promise<void> | undefined
  private disposed = false

  constructor(private readonly options: ContentIndexOptions) {}

  get dir(): string {
    return this.options.dir
  }

  /** How many sessions have indexed content. */
  get size(): number {
    return this.texts.size
  }

  async load(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true })
    this.manifest = await readManifest(join(this.options.dir, MANIFEST))
    let names: string[] = []
    try {
      names = await readdir(this.options.dir)
    } catch {
      // Nothing indexed yet.
    }
    for (const name of names) {
      if (!name.endsWith('.txt')) continue
      const id = name.slice(0, -4)
      if (!this.manifest.sessions[id]) continue // a file with no offset is rebuilt on catch-up
      try {
        this.texts.set(id, (await readFile(join(this.options.dir, name), 'utf8')).toLowerCase())
      } catch {
        delete this.manifest.sessions[id]
      }
    }
    this.loaded = true
  }

  /**
   * Bring the content of `entries` up to date: skip ones already at their
   * size, append from the recorded offset otherwise, rebuild ones whose file
   * shrank. Largest last, one at a time, yielding regularly. Concurrent calls
   * queue behind the running one.
   */
  catchUp(entries: readonly SessionIndexEntry[], signal?: AbortSignal): Promise<void> {
    const run = async () => {
      if (!this.loaded) throw new Error('ContentIndex.load() must run first')
      const work = entries
        .filter((e) => !e.missing && this.needs(e))
        .sort((a, b) => a.size - b.size)
      let changed = 0
      for (const entry of work) {
        if (this.disposed || signal?.aborted) break
        try {
          if (await this.index(entry, signal)) changed++
        } catch (err) {
          this.options.log?.(`content: ${entry.sessionId} failed: ${String(err)}`)
        }
      }
      if (changed) await this.saveManifest()
    }
    const next = (this.running ?? Promise.resolve()).then(run, run)
    this.running = next
    return next
  }

  private needs(entry: SessionIndexEntry): boolean {
    const m = this.manifest.sessions[entry.sessionId]
    if (!m || !this.texts.has(entry.sessionId)) return true
    return m.to < entry.size || m.size > entry.size
  }

  private async index(entry: SessionIndexEntry, signal?: AbortSignal): Promise<boolean> {
    const st = await stat(entry.filePath)
    const previous = this.manifest.sessions[entry.sessionId]
    const restart = !previous || !this.texts.has(entry.sessionId) || previous.to > st.size
    const from = restart ? 0 : previous.to
    if (!restart && from >= st.size) return false
    const path = join(this.options.dir, `${entry.sessionId}.txt`)
    let consumed = from
    let lines = 0
    const added: string[] = []
    for await (const { line, endOffset } of streamLines(entry.filePath, from)) {
      if (signal?.aborted || this.disposed) return false
      const rec = parseRecord(line)
      if (rec && isConversational(rec)) {
        const text = textOf(rec)
          .replace(/\s*\n\s*/g, ' ')
          .trim()
        if (text) added.push(text)
      }
      consumed = endOffset
      if (++lines % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r))
    }
    const chunk = added.length ? `${added.join('\n')}\n` : ''
    if (restart) await writeFile(path, chunk)
    else if (chunk) await appendFile(path, chunk)
    const lower = chunk.toLowerCase()
    this.texts.set(
      entry.sessionId,
      restart ? lower : `${this.texts.get(entry.sessionId) ?? ''}${lower}`
    )
    this.manifest.sessions[entry.sessionId] = { to: consumed, size: st.size }
    this.manifestDirty = true
    return true
  }

  /** Is every one of `words` somewhere in this session's transcript text? */
  contains(sessionId: string, words: readonly string[]): boolean {
    const text = this.texts.get(sessionId)
    if (text === undefined) return false
    return words.every((w) => text.includes(w))
  }

  /** Which of `words` occur in this session's transcript text. */
  wordsIn(sessionId: string, words: readonly string[]): string[] {
    const text = this.texts.get(sessionId)
    if (text === undefined) return []
    return words.filter((w) => text.includes(w))
  }

  /** Original-case context around the first occurrence of `word`, or undefined when absent. */
  async snippet(sessionId: string, word: string): Promise<string | undefined> {
    let text: string
    try {
      text = await readFile(join(this.options.dir, `${sessionId}.txt`), 'utf8')
    } catch {
      return undefined
    }
    const at = text.toLowerCase().indexOf(word)
    if (at === -1) return undefined
    const half = Math.floor((SNIPPET_CHARS - word.length) / 2)
    const start = Math.max(0, at - half)
    const end = Math.min(text.length, at + word.length + half)
    const raw = text.slice(start, end).replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '…' : ''}${raw}${end < text.length ? '…' : ''}`
  }

  private async saveManifest(): Promise<void> {
    if (!this.manifestDirty) return
    this.manifestDirty = false
    const json = `${JSON.stringify(this.manifest, null, 2)}\n`
    this.saving = writeFileAtomic(join(this.options.dir, MANIFEST), json)
    await this.saving
  }

  async dispose(): Promise<void> {
    this.disposed = true
    try {
      await this.running
    } catch {
      // Logged by catchUp.
    }
    await this.saveManifest()
  }
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, sessions: {} }
    const sessions = (parsed as { sessions?: unknown }).sessions
    if (typeof sessions !== 'object' || sessions === null) return { version: 1, sessions: {} }
    const out: Record<string, ManifestEntry> = {}
    for (const [id, v] of Object.entries(sessions as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue
      const { to, size } = v as Record<string, unknown>
      if (typeof to === 'number' && typeof size === 'number' && to >= 0 && size >= 0)
        out[id] = { to, size }
    }
    return { version: 1, sessions: out }
  } catch {
    return { version: 1, sessions: {} }
  }
}
