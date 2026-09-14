import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadIndexCache, saveIndexCache } from './cache'
import type { LiveSession } from './liveSessions'
import { readLiveSessions } from './liveSessions'
import { fastTier, fullTier } from './tiers'
import type { SessionIndexEntry } from './types'

export interface IndexerOptions {
  /** `~/.claude/projects` */
  projectsDir: string
  /** `~/.claude/sessions` */
  sessionsDir: string
  /** Where the disposable cache is written (globalStorage). */
  cachePath: string
  /** Files above this size get the fast tier only. */
  fullTierMaxBytes: number
  /**
   * Which entries deserve the full pass. Hidden producers (`sdk-cli` by
   * default) stay fast-tier so the machine is not spent on logs nobody views.
   */
  wantsFullTier: (entry: SessionIndexEntry) => boolean
  fullTierConcurrency?: number
  fastTierConcurrency?: number
  /** Polling interval used only when fs.watch is unavailable. */
  pollIntervalMs?: number
  log?: (message: string) => void
}

export interface IndexStatus {
  total: number
  /** Entries with a completed full pass. */
  complete: number
  /** Entries still fast-tier and queued for the full pass. */
  pending: number
  /** Entries that will stay fast-tier (too large or hidden). */
  fastOnly: number
  missing: number
  parseErrors: number
  /** Bytes read by the last scan — the P1 "re-parse zero bytes" acceptance. */
  lastScanBytesRead: number
  scanning: boolean
}

export type IndexListener = (changedIds: string[]) => void

/**
 * Owns the map of session entries and keeps it current (spec §5). No vscode
 * imports: the extension wraps it, tests drive it directly.
 */
export class SessionIndexer {
  private readonly sessions = new Map<string, SessionIndexEntry>()
  private readonly listeners = new Set<IndexListener>()
  private readonly fullQueue: string[] = []
  private readonly inFlight = new Set<string>()
  private watcher: FSWatcher | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private rescanTimer: NodeJS.Timeout | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private notifyTimer: NodeJS.Timeout | undefined
  private pendingNotify = new Set<string>()
  private pendingPaths = new Set<string>()
  private pendingFullRescan = false
  private queuedPaths = new Set<string>()
  private queuedFullScan = false
  private abort = new AbortController()
  private disposed = false
  private scanning = false
  private lastScanBytesRead = 0
  private fullPassesRunning = 0

  constructor(private readonly options: IndexerOptions) {}

  /** Load the cache, scan the projects dir, start watching. Resolves after the fast tier. */
  async start(): Promise<void> {
    const cached = await loadIndexCache(this.options.cachePath)
    for (const [id, entry] of cached) this.sessions.set(id, entry)
    await this.scan()
    this.startWatching()
  }

  /** Rescan every file; unchanged ones cost a stat and nothing else. */
  async refresh(): Promise<void> {
    await this.scan()
  }

  /** Re-index just these files (what the watcher does). Deleted paths become `missing`. */
  async refreshPaths(paths: string[]): Promise<void> {
    await this.scan(paths)
  }

  /** Drop the cache and index everything again. */
  async reindex(): Promise<void> {
    this.abort.abort()
    this.abort = new AbortController()
    this.fullQueue.length = 0
    this.sessions.clear()
    await this.scan()
  }

  getAll(): SessionIndexEntry[] {
    return [...this.sessions.values()]
  }

  get(sessionId: string): SessionIndexEntry | undefined {
    return this.sessions.get(sessionId)
  }

  status(): IndexStatus {
    let complete = 0
    let pending = 0
    let fastOnly = 0
    let missing = 0
    let parseErrors = 0
    for (const entry of this.sessions.values()) {
      if (entry.missing) {
        missing++
        continue
      }
      parseErrors += entry.parseErrors
      if (!entry.fast) complete++
      else if (this.eligibleForFull(entry)) pending++
      else fastOnly++
    }
    return {
      total: this.sessions.size,
      complete,
      pending,
      fastOnly,
      missing,
      parseErrors,
      lastScanBytesRead: this.lastScanBytesRead,
      scanning: this.scanning || this.fullPassesRunning > 0,
    }
  }

  liveSessions(): Promise<LiveSession[]> {
    return readLiveSessions(this.options.sessionsDir)
  }

  onDidChange(listener: IndexListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stops watching and background passes; resolves once the final cache write is done. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.abort.abort()
    this.watcher?.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      await this.save()
    }
  }

  // --- scanning -----------------------------------------------------------

  /**
   * Index every file (a full sweep, which is also the only way a deleted file
   * is noticed) or, when `paths` is given, just those files. A scan requested
   * while one is running is queued rather than dropped, so a watcher event
   * that lands mid-sweep is never lost.
   */
  private async scan(paths?: string[]): Promise<void> {
    if (this.scanning) {
      if (paths) for (const p of paths) this.queuedPaths.add(p)
      else this.queuedFullScan = true
      return
    }
    this.scanning = true
    let bytesRead = 0
    try {
      const fullSweep = paths === undefined
      const files = fullSweep ? await this.listSessionFiles() : paths
      const seen = new Set<string>()
      const changed: string[] = []
      const work: Array<() => Promise<void>> = []
      for (const filePath of files) {
        const sessionId = basenameNoExt(filePath)
        seen.add(sessionId)
        work.push(async () => {
          let st
          try {
            st = await stat(filePath)
          } catch {
            // A targeted scan of a path that no longer exists is a deletion.
            const gone = this.sessions.get(sessionId)
            if (gone && !gone.missing && gone.filePath === filePath) {
              gone.missing = true
              changed.push(sessionId)
            }
            return
          }
          const existing = this.sessions.get(sessionId)
          if (
            existing &&
            !existing.missing &&
            existing.size === st.size &&
            existing.mtimeMs === st.mtimeMs
          ) {
            return
          }
          try {
            const result = await fastTier(filePath)
            bytesRead += result.bytesRead
            if (
              existing &&
              !existing.fast &&
              existing.parsedTo <= st.size &&
              existing.filePath === filePath
            ) {
              // The file only grew: keep the completed counts and let the full
              // pass resume from parsedTo. The fast tier's fresh "latest wins"
              // fields are adopted right away so the card is current.
              const merged: SessionIndexEntry = {
                ...existing,
                size: st.size,
                mtimeMs: st.mtimeMs,
                missing: false,
                lastActiveAt: result.entry.lastActiveAt,
                preview: result.entry.preview ?? existing.preview,
                lastPrompt: result.entry.lastPrompt ?? existing.lastPrompt,
                aiTitle: result.entry.aiTitle ?? existing.aiTitle,
                customTitle: result.entry.customTitle ?? existing.customTitle,
              }
              this.sessions.set(sessionId, merged)
            } else {
              this.sessions.set(sessionId, result.entry)
            }
            changed.push(sessionId)
          } catch (err) {
            this.options.log?.(`fast tier failed for ${filePath}: ${String(err)}`)
          }
        })
      }
      await runLimited(work, this.options.fastTierConcurrency ?? 8)
      if (fullSweep) {
        for (const [id, entry] of this.sessions) {
          if (!seen.has(id) && !entry.missing) {
            entry.missing = true
            changed.push(id)
          }
        }
        this.lastScanBytesRead = bytesRead
      }
      this.enqueueFullPasses()
      if (changed.length) {
        this.notify(changed)
        this.scheduleSave()
      }
    } finally {
      this.scanning = false
    }
    // Drain whatever was requested while this scan ran.
    if (this.queuedFullScan) {
      this.queuedFullScan = false
      this.queuedPaths.clear()
      await this.scan()
    } else if (this.queuedPaths.size) {
      const next = [...this.queuedPaths]
      this.queuedPaths.clear()
      await this.scan(next)
    }
  }

  private async listSessionFiles(): Promise<string[]> {
    let slugs: string[]
    try {
      slugs = await readdir(this.options.projectsDir)
    } catch {
      return []
    }
    const files: string[] = []
    await runLimited(
      slugs.map((slug) => async () => {
        const dir = join(this.options.projectsDir, slug)
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          return
        }
        for (const name of names) if (name.endsWith('.jsonl')) files.push(join(dir, name))
      }),
      16
    )
    return files
  }

  // --- full tier ------------------------------------------------------------

  private eligibleForFull(entry: SessionIndexEntry): boolean {
    return (
      !entry.missing &&
      entry.size <= this.options.fullTierMaxBytes &&
      this.options.wantsFullTier(entry)
    )
  }

  private enqueueFullPasses(): void {
    const queued = new Set(this.fullQueue)
    const candidates: SessionIndexEntry[] = []
    for (const entry of this.sessions.values()) {
      const needsPass = entry.fast || entry.parsedTo < entry.size
      if (
        needsPass &&
        this.eligibleForFull(entry) &&
        !queued.has(entry.sessionId) &&
        !this.inFlight.has(entry.sessionId)
      ) {
        candidates.push(entry)
      }
    }
    // Resumable (already complete once) files first, then smallest first, so
    // the biggest cold file is the last thing the machine does.
    candidates.sort((a, b) => Number(a.fast) - Number(b.fast) || a.size - b.size)
    for (const c of candidates) this.fullQueue.push(c.sessionId)
    this.pumpFullQueue()
  }

  private pumpFullQueue(): void {
    const limit = this.options.fullTierConcurrency ?? 2
    while (!this.disposed && this.fullPassesRunning < limit && this.fullQueue.length) {
      const id = this.fullQueue.shift()
      if (!id) break
      const entry = this.sessions.get(id)
      if (!entry || entry.missing) continue
      this.fullPassesRunning++
      this.inFlight.add(id)
      const signal = this.abort.signal
      void fullTier(entry, signal)
        .then((result) => {
          if (signal.aborted || this.disposed) return
          const current = this.sessions.get(id)
          // A scan may have refreshed the entry meanwhile; only adopt the pass
          // if the file is still the one it read.
          if (current && current.filePath === result.entry.filePath) {
            this.sessions.set(id, { ...result.entry, missing: current.missing })
            this.notify([id])
            this.scheduleSave()
          }
        })
        .catch((err: unknown) => this.options.log?.(`full tier failed for ${id}: ${String(err)}`))
        .finally(() => {
          this.fullPassesRunning--
          this.inFlight.delete(id)
          // The file may have grown while its pass ran; enqueue picks that up
          // (parsedTo < size) now that the id is no longer in flight.
          this.enqueueFullPasses()
        })
    }
  }

  // --- watching -------------------------------------------------------------

  private startWatching(): void {
    try {
      this.watcher = watch(this.options.projectsDir, { recursive: true }, (_event, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
          this.pendingPaths.add(join(this.options.projectsDir, filename))
        } else {
          // No filename (some platforms) or a directory event: sweep everything.
          this.pendingFullRescan = true
        }
        this.scheduleRescan(500)
      })
      // Deletions only surface from a full sweep; do one occasionally.
      this.pollTimer = setInterval(
        () => void this.scan(),
        this.options.pollIntervalMs ?? 5 * 60_000
      )
      this.watcher.on('error', (err) => {
        this.options.log?.(`watch error, falling back to polling: ${String(err)}`)
        this.watcher?.close()
        this.watcher = undefined
        this.startPolling()
      })
    } catch (err) {
      this.options.log?.(`fs.watch unavailable, polling instead: ${String(err)}`)
      this.startPolling()
    }
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => void this.scan(), this.options.pollIntervalMs ?? 30_000)
  }

  private scheduleRescan(delayMs: number): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined
      const paths = [...this.pendingPaths]
      const full = this.pendingFullRescan
      this.pendingPaths.clear()
      this.pendingFullRescan = false
      void (full ? this.scan() : this.scan(paths))
    }, delayMs)
  }

  // --- notification + persistence --------------------------------------------

  private notify(ids: string[]): void {
    for (const id of ids) this.pendingNotify.add(id)
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      const batch = [...this.pendingNotify]
      this.pendingNotify.clear()
      for (const listener of this.listeners) {
        try {
          listener(batch)
        } catch (err) {
          this.options.log?.(`index listener threw: ${String(err)}`)
        }
      }
    }, 100)
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, 2_000)
  }

  private async save(): Promise<void> {
    try {
      await saveIndexCache(this.options.cachePath, this.sessions)
    } catch (err) {
      this.options.log?.(`index cache save failed: ${String(err)}`)
    }
  }

  /** Test seam: resolves once no full pass is running or queued. */
  async whenIdle(): Promise<void> {
    while (this.fullPassesRunning > 0 || this.fullQueue.length > 0 || this.scanning) {
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** Test seam: flush the debounced cache write now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.save()
  }
}

function basenameNoExt(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const name = filePath.slice(slash + 1)
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name
}

async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      if (task) await task()
    }
  })
  await Promise.all(workers)
}
