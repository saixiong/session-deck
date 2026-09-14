import * as vscode from 'vscode'
import type { DashboardState, HostToWebview } from '../../shared/messages'
import { isWebviewToHost } from '../../shared/messages'
import { renderDashboardHtml } from './html'

/**
 * Hosts the dashboard webview. One panel per window: opening it again
 * reveals the existing one. `retainContextWhenHidden` keeps the Preact state
 * (view mode, tip index, scroll) alive across tab switches, which matters
 * more than the memory it costs.
 */
export class DashboardPanel {
  public static readonly viewType = 'sessionDeck.dashboard'
  private static current: DashboardPanel | undefined

  private readonly disposables: vscode.Disposable[] = []

  static show(context: vscode.ExtensionContext): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column)
      return DashboardPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Session Deck',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      }
    )
    DashboardPanel.current = new DashboardPanel(panel, context)
    return DashboardPanel.current
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'deck.svg')
    panel.webview.html = this.html()
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
    panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw), null, this.disposables)
  }

  private html(): string {
    const asset = (name: string) =>
      this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name))
        .toString()
    return renderDashboardHtml(this.panel.webview, {
      script: asset('index.js'),
      style: asset('index.css'),
    })
  }

  private onMessage(raw: unknown): void {
    // A message we do not recognise is a version skew, not an error.
    if (!isWebviewToHost(raw)) return
    switch (raw.type) {
      case 'ready':
        void this.send({ type: 'state', state: this.placeholderState() })
        return
      case 'openExternal':
        void vscode.env.openExternal(vscode.Uri.parse(raw.url))
        return
      case 'command':
        void this.send({ type: 'state', state: this.placeholderState() })
        return
    }
  }

  /** P0: the stat strip is wired but reads nothing yet. P1 replaces this with the index. */
  private placeholderState(): DashboardState {
    const version = (this.context.extension.packageJSON as { version?: string }).version ?? '0.0.0'
    return {
      extensionVersion: version,
      phase: 'P0',
      stats: [
        { id: 'live', label: 'Live', value: '—', hint: 'sessions running now' },
        { id: 'active', label: 'Active', value: '—', hint: 'in period' },
        { id: 'tokens', label: 'Output tokens', value: '—', hint: 'in period' },
        { id: 'prs', label: 'PRs', value: '—', hint: 'linked in period' },
        { id: 'favorites', label: 'Favorites', value: '0' },
        { id: 'index', label: 'Index', value: 'not built', hint: 'arrives in P1' },
      ],
    }
  }

  private send(message: HostToWebview): Thenable<boolean> {
    return this.panel.webview.postMessage(message)
  }

  private dispose(): void {
    DashboardPanel.current = undefined
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
