import { join } from 'node:path'
import * as vscode from 'vscode'
import {
  createIndexer,
  INDEXER_SETTING_KEYS,
  isVisibleEntry,
  readIndexerSettings,
  type IndexerSettings,
} from './index/createIndexer'
import type { LiveSession } from './index/liveSessions'
import type { SessionIndexer } from './index/SessionIndexer'
import { SessionOpener } from './open/SessionOpener'
import { SessionResolver } from './registry/sessionResolver'
import { ResolverRegistry } from './registry/types'
import { FavoritesStore } from './store/FavoritesStore'
import { expandHome } from './util/paths'

const LIVE_TTL_MS = 5_000

/**
 * The long-lived objects every view shares. Constructed once at activation;
 * the indexer starts in the background so activation stays cheap, and is
 * rebuilt when a setting it depends on changes.
 */
export class Services implements vscode.Disposable {
  readonly output: vscode.OutputChannel
  readonly favorites: FavoritesStore
  readonly registry = new ResolverRegistry()
  readonly sessions: SessionResolver
  readonly opener: SessionOpener
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
    this.indexerInstance = this.boot(createIndexer(context, this.output))
    this.opener = new SessionOpener(this.output)

    const dataDir = expandHome(
      vscode.workspace.getConfiguration('sessionDeck').get<string>('dataDir', '~/.session-deck')
    )
    this.favorites = new FavoritesStore(join(dataDir, 'favorites.json'))
    this.favorites.onDidChange(() => this.favoritesEmitter.fire())
    this.favoritesReady = this.favorites.load().then(
      () => this.favorites.watch(),
      (err: unknown) => this.output.appendLine(`[favorites] load failed: ${String(err)}`)
    )

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
    this.unsubscribeIndex = indexer.onDidChange((ids) => this.indexEmitter.fire(ids))
    indexer.start().then(
      () => this.output.appendLine(`[index] ready: ${JSON.stringify(indexer.status())}`),
      (err: unknown) => {
        this.output.appendLine(`[index] start failed: ${String(err)}`)
        void vscode.window.showErrorMessage(
          `Session Deck: could not index sessions (${String(err)})`
        )
      }
    )
    return indexer
  }

  private restartIndexer(): void {
    const old = this.indexerInstance
    this.settingsSnapshot = readIndexerSettings()
    this.indexerInstance = this.boot(createIndexer(this.context, this.output))
    void old.dispose()
    this.indexEmitter.fire([])
  }

  dispose(): void {
    this.unsubscribeIndex?.()
    void this.indexerInstance.dispose()
    this.favorites.dispose()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
