import * as vscode from 'vscode'
import {
  createIndexer,
  INDEXER_SETTING_KEYS,
  readIndexerSettings,
  type IndexerSettings,
} from './index/createIndexer'
import type { SessionIndexer } from './index/SessionIndexer'

/**
 * The long-lived objects every view shares. Constructed once at activation;
 * the indexer starts in the background so activation stays cheap, and is
 * rebuilt when a setting it depends on changes.
 */
export class Services implements vscode.Disposable {
  readonly output: vscode.OutputChannel
  private indexerInstance: SessionIndexer
  private settingsSnapshot: IndexerSettings
  private readonly emitter = new vscode.EventEmitter<string[]>()
  private unsubscribe: (() => void) | undefined
  private readonly disposables: vscode.Disposable[] = []

  /** Fires with the changed session ids whenever the index moves. */
  readonly onDidChangeIndex = this.emitter.event

  constructor(readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Session Deck')
    this.settingsSnapshot = readIndexerSettings()
    this.indexerInstance = this.boot(createIndexer(context, this.output))
    this.disposables.push(
      this.output,
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (INDEXER_SETTING_KEYS.some((k) => e.affectsConfiguration(k))) this.restartIndexer()
      })
    )
  }

  get indexer(): SessionIndexer {
    return this.indexerInstance
  }

  get settings(): IndexerSettings {
    return this.settingsSnapshot
  }

  get version(): string {
    return (this.context.extension.packageJSON as { version?: string }).version ?? '0.0.0'
  }

  private boot(indexer: SessionIndexer): SessionIndexer {
    this.unsubscribe?.()
    this.unsubscribe = indexer.onDidChange((ids) => this.emitter.fire(ids))
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
  }

  dispose(): void {
    this.unsubscribe?.()
    void this.indexerInstance.dispose()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
