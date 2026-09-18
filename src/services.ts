import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { runClaude } from './analyze/ClaudeCli'
import { ReviewRunner } from './analyze/ReviewRunner'
import { ReviewStore } from './analyze/ReviewStore'
import { buildTranscript } from './analyze/transcript'
import {
  createIndexer,
  INDEXER_SETTING_KEYS,
  isVisibleEntry,
  readIndexerSettings,
  type IndexerSettings,
} from './index/createIndexer'
import { ContentIndex } from './index/ContentIndex'
import type { LiveSession } from './index/liveSessions'
import type { SessionIndexer } from './index/SessionIndexer'
import { SessionOpener } from './open/SessionOpener'
import { SessionResolver } from './registry/sessionResolver'
import { ResolverRegistry } from './registry/types'
import { BoardStore } from './store/BoardStore'
import { FavoritesStore } from './store/FavoritesStore'
import { resolveClaudeCli } from './util/claudeCli'
import { expandHome } from './util/paths'

const REVIEW_TIMEOUT_MS = 180_000

const LIVE_TTL_MS = 5_000

/**
 * The long-lived objects every view shares. Constructed once at activation;
 * the indexer starts in the background so activation stays cheap, and is
 * rebuilt when a setting it depends on changes.
 */
export class Services implements vscode.Disposable {
  readonly output: vscode.OutputChannel
  readonly favorites: FavoritesStore
  readonly board: BoardStore
  readonly registry = new ResolverRegistry()
  readonly sessions: SessionResolver
  readonly opener: SessionOpener
  readonly reviews: ReviewStore
  readonly runner: ReviewRunner
  /** Transcript text for search (SPEC_SEARCH S6); catches up in the background behind the index. */
  readonly content: ContentIndex
  private contentTimer: NodeJS.Timeout | undefined
  private contentReady: Promise<void>
  private indexerInstance: SessionIndexer
  private settingsSnapshot: IndexerSettings
  private readonly indexEmitter = new vscode.EventEmitter<string[]>()
  private readonly favoritesEmitter = new vscode.EventEmitter<void>()
  private unsubscribeIndex: (() => void) | undefined
  private liveCache: { at: number; value: LiveSession[] } = { at: 0, value: [] }
  private readonly disposables: vscode.Disposable[] = []

  /** Fires with the changed session ids whenever the index moves. */
  readonly onDidChangeIndex = this.indexEmitter.event
  /** Fires after any favorites write, local or from another window. */
  readonly onDidChangeFavorites = this.favoritesEmitter.event

  constructor(readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Session Deck')
    this.settingsSnapshot = readIndexerSettings()
    this.content = new ContentIndex({
      dir: join(context.globalStorageUri.fsPath, 'content'),
      log: (m) => this.output.appendLine(`[index] ${m}`),
    })
    this.contentReady = this.content
      .load()
      .catch((err: unknown) =>
        this.output.appendLine(`[index] content load failed: ${String(err)}`)
      )
    this.indexerInstance = this.boot(createIndexer(context, this.output))
    this.opener = new SessionOpener(this.output, {
      // Read fresh, not from the 5 s cache: this decides whether a panel is
      // closed, and "busy" can begin between two dashboard pushes.
      liveStatus: async (id) =>
        (await this.indexerInstance.liveSessions()).find((l) => l.sessionId === id)?.status,
    })

    const dataDir = expandHome(
      vscode.workspace.getConfiguration('sessionDeck').get<string>('dataDir', '~/.session-deck')
    )
    this.favorites = new FavoritesStore(join(dataDir, 'favorites.json'))
    this.favorites.onDidChange(() => this.favoritesEmitter.fire())
    // The board shares the favorites signal: both change what the dashboard
    // must redraw, and the panel rebuilds its whole state either way.
    this.board = new BoardStore(join(dataDir, 'board.json'))
    this.board.onDidChange(() => this.favoritesEmitter.fire())
    this.reviews = new ReviewStore(join(dataDir, 'reviews'))
    this.favoritesReady = Promise.all([
      this.favorites.load().then(
        () => this.favorites.watch(),
        (err: unknown) => this.output.appendLine(`[favorites] load failed: ${String(err)}`)
      ),
      this.board.load().then(
        () => this.board.watch(),
        (err: unknown) => this.output.appendLine(`[board] load failed: ${String(err)}`)
      ),
      this.reviews
        .load()
        .catch((err: unknown) => this.output.appendLine(`[reviews] load failed: ${String(err)}`)),
    ]).then(() => this.pruneBoard())

    // The runner reads settings per call so a model change applies to the next batch.
    const config = () => vscode.workspace.getConfiguration('sessionDeck')
    this.runner = new ReviewRunner({
      getEntry: (id) => this.indexerInstance.get(id),
      buildTranscript: (entry) =>
        buildTranscript(entry, { turns: config().get<number>('transcriptTurns', 80) }),
      callModel: async ({ prompt, systemPrompt, schema, signal }) => {
        const cli = await resolveClaudeCli()
        if (!cli) {
          return {
            ok: false,
            structured: undefined,
            resultText: undefined,
            costUsd: null,
            durationMs: null,
            errorText: 'no claude CLI found — set sessionDeck.claudePath',
          }
        }
        // A neutral cwd: no CLAUDE.md, no project settings, nothing of the user's.
        const cwd = join(context.globalStorageUri.fsPath, 'review-cwd')
        await mkdir(cwd, { recursive: true })
        return runClaude({
          cliPath: cli.path,
          prompt,
          systemPrompt,
          schema,
          model: config().get<string>('model', 'sonnet'),
          cwd,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal,
        })
      },
      store: this.reviews,
      get model() {
        return config().get<string>('model', 'sonnet')
      },
      get concurrency() {
        return Math.max(1, Math.min(8, config().get<number>('concurrency', 4)))
      },
      log: (m) => this.output.appendLine(`[review] ${m}`),
    })

    this.sessions = new SessionResolver({
      entries: () => this.indexerInstance.getAll(),
      get: (id) => this.indexerInstance.get(id),
      live: () => this.liveCache.value,
      isVisible: (e) => isVisibleEntry(e, this.settingsSnapshot),
      workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    })
    this.registry.register(this.sessions)

    this.disposables.push(
      this.output,
      this.indexEmitter,
      this.favoritesEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (INDEXER_SETTING_KEYS.some((k) => e.affectsConfiguration(k))) this.restartIndexer()
      })
    )
  }

  /** Resolves once favorites.json has been read (activation does not wait for it). */
  readonly favoritesReady: Promise<void>

  get indexer(): SessionIndexer {
    return this.indexerInstance
  }

  get settings(): IndexerSettings {
    return this.settingsSnapshot
  }

  get version(): string {
    return (this.context.extension.packageJSON as { version?: string }).version ?? '0.0.0'
  }

  /** Live sessions, re-read at most every few seconds; views call this before rendering. */
  async refreshLive(): Promise<LiveSession[]> {
    if (Date.now() - this.liveCache.at > LIVE_TTL_MS) {
      this.liveCache = { at: Date.now(), value: await this.indexerInstance.liveSessions() }
    }
    return this.liveCache.value
  }

  private boot(indexer: SessionIndexer): SessionIndexer {
    this.unsubscribeIndex?.()
    this.unsubscribeIndex = indexer.onDidChange((ids) => {
      this.indexEmitter.fire(ids)
      this.scheduleContentCatchUp()
    })
    indexer.start().then(
      () => {
        this.output.appendLine(`[index] ready: ${JSON.stringify(indexer.status())}`)
        this.scheduleContentCatchUp()
      },
      (err: unknown) => {
        this.output.appendLine(`[index] start failed: ${String(err)}`)
        void vscode.window.showErrorMessage(
          `Session Deck: could not index sessions (${String(err)})`
        )
      }
    )
    return indexer
  }

  /**
   * The content index trails the session index: every change it reports
   * (coalesced, since the full tier reports in bursts) brings the visible
   * sessions' text up to date, largest last. A push to the dashboard follows
   * so a search typed during the catch-up sees the new matches.
   */
  private scheduleContentCatchUp(): void {
    if (this.contentTimer) clearTimeout(this.contentTimer)
    this.contentTimer = setTimeout(() => {
      this.contentTimer = undefined
      void this.contentReady.then(async () => {
        const before = this.content.size
        const wanted = this.indexerInstance
          .getAll()
          .filter((e) => isVisibleEntry(e, this.settingsSnapshot))
        await this.content.catchUp(wanted)
        if (this.content.size !== before) this.indexEmitter.fire([])
      })
    }, 1000)
  }

  private restartIndexer(): void {
    const old = this.indexerInstance
    this.settingsSnapshot = readIndexerSettings()
    this.indexerInstance = this.boot(createIndexer(this.context, this.output))
    void old.dispose()
    this.indexEmitter.fire([])
  }

  /**
   * `board.json` is pruned once both stores are loaded (B3.2): `seeded` rows
   * whose session nobody stars any more expire after 30 days, so a file that
   * only ever grows is not the price of using the Board. `done` and
   * `dismissed` are decisions and are kept regardless of staleness.
   *
   * Never fatal — a board that could not be pruned is still a usable board.
   */
  private async pruneBoard(): Promise<void> {
    try {
      const starred = new Set(this.favorites.listByType('session').map((f) => f.entity_id))
      const removed = await this.board.prune(starred)
      if (removed) this.output.appendLine(`[board] pruned ${removed} expired seeded item(s)`)
    } catch (err) {
      this.output.appendLine(`[board] prune failed: ${String(err)}`)
    }
  }

  dispose(): void {
    this.unsubscribeIndex?.()
    if (this.contentTimer) clearTimeout(this.contentTimer)
    void this.content.dispose()
    void this.indexerInstance.dispose()
    this.favorites.dispose()
    this.board.dispose()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
