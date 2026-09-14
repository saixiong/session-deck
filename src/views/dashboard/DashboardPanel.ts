import * as vscode from 'vscode'
import { isVisibleEntry } from '../../index/createIndexer'
import { computeStats, formatCount, isPeriod } from '../../index/stats'
import { buildFavoriteGroups } from '../../registry/favoritesView'
import type { Services } from '../../services'
import type { FavoriteCard } from '../../shared/cards'
import type {
  DashboardPrefs,
  DashboardState,
  HostToWebview,
  Period,
  StatTileData,
  WebviewToHost,
} from '../../shared/messages'
import { DEFAULT_PREFS, isWebviewToHost } from '../../shared/messages'
import { renderDashboardHtml } from './html'

const PERIOD_KEY = 'sessionDeck.dashboard.period'
const PREFS_KEY = 'sessionDeck.dashboard.prefs'
const SUGGESTED_LIMIT = 12
const BROWSE_MAX = 200

/**
 * Hosts the dashboard webview. One panel per window: opening it again
 * reveals the existing one. `retainContextWhenHidden` keeps the Preact state
 * (tip index, scroll, open picker) alive across tab switches, which matters
 * more than the memory it costs.
 */
export class DashboardPanel {
  public static readonly viewType = 'sessionDeck.dashboard'
  private static current: DashboardPanel | undefined

  private readonly disposables: vscode.Disposable[] = []
  private pushTimer: NodeJS.Timeout | undefined

  static show(services: Services): DashboardPanel {
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
        localResourceRoots: [vscode.Uri.joinPath(services.context.extensionUri, 'dist', 'webview')],
      }
    )
    DashboardPanel.current = new DashboardPanel(panel, services)
    return DashboardPanel.current
  }

  /**
   * Re-adopts a panel VS Code restored from a previous window session, so the
   * tab is live after a restart instead of an empty shell.
   */
  static register(services: Services): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(DashboardPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
        panel.webview.options = {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(services.context.extensionUri, 'dist', 'webview'),
          ],
        }
        DashboardPanel.current?.panel.dispose()
        DashboardPanel.current = new DashboardPanel(panel, services)
        return Promise.resolve()
      },
    })
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly services: Services
  ) {
    const { context } = services
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'deck.svg')
    panel.webview.html = this.html()
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
    panel.webview.onDidReceiveMessage(
      (raw: unknown) => void this.onMessage(raw),
      null,
      this.disposables
    )
    // Index changes arrive in bursts while the full tier runs; coalesce them.
    this.disposables.push(
      services.onDidChangeIndex(() => this.schedulePush()),
      services.onDidChangeFavorites(() => this.schedulePush()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedulePush())
    )
  }

  private html(): string {
    const asset = (name: string) =>
      this.panel.webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.services.context.extensionUri, 'dist', 'webview', name)
        )
        .toString()
    return renderDashboardHtml(this.panel.webview, {
      script: asset('index.js'),
      style: asset('index.css'),
    })
  }

  private async onMessage(raw: unknown): Promise<void> {
    // A message we do not recognise is a version skew, not an error.
    if (!isWebviewToHost(raw)) return
    try {
      await this.handle(raw)
    } catch (err) {
      this.services.output.appendLine(`[dashboard] ${raw.type} failed: ${String(err)}`)
      await this.send({ type: 'toast', level: 'error', text: `${raw.type} failed: ${String(err)}` })
    }
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    const { services } = this
    switch (msg.type) {
      case 'ready':
        await services.favoritesReady
        await this.push()
        return
      case 'openExternal': {
        // The webview is trusted code, but a link it renders may not be:
        // only web URLs leave the editor.
        const uri = vscode.Uri.parse(msg.url)
        if (uri.scheme === 'https' || uri.scheme === 'http') void vscode.env.openExternal(uri)
        return
      }
      case 'setPeriod':
        await services.context.globalState.update(PERIOD_KEY, msg.period)
        await this.push()
        return
      case 'setPrefs':
        await services.context.globalState.update(PREFS_KEY, { ...this.prefs, ...msg.prefs })
        await this.push()
        return
      case 'command':
        if (msg.command === 'reindex') await services.indexer.reindex()
        else await services.indexer.refresh()
        await this.push()
        return
      case 'toggleFavorite': {
        await services.favoritesReady
        const { favorites } = services
        if (favorites.has(msg.entityType, msg.entityId)) {
          await favorites.removeByEntity(msg.entityType, msg.entityId)
        } else {
          await favorites.add({
            entityType: msg.entityType,
            entityId: msg.entityId,
            label: msg.label,
          })
        }
        return // the favorites change event pushes
      }
      case 'removeFavorite':
        await services.favoritesReady
        await services.favorites.removeById(msg.id)
        return
      case 'moveFavorite':
        await services.favoritesReady
        await services.favorites.moveBefore(msg.id, msg.beforeId ?? undefined)
        return
      case 'open': {
        if (msg.entityType !== 'session') return
        const entry = services.indexer.get(msg.entityId)
        await services.opener.open({
          sessionId: msg.entityId,
          ...(msg.prompt ? { prompt: msg.prompt } : {}),
          ...(entry?.cwd ? { cwd: entry.cwd } : {}),
          ...(msg.target === 'window' || msg.target === 'terminal' ? { target: msg.target } : {}),
        })
        return
      }
      case 'browse': {
        const resolver = services.registry.get(msg.entityType)
        if (!resolver) return
        const limit = Math.max(1, Math.min(BROWSE_MAX, Math.floor(msg.limit)))
        const { items, total } = resolver.browse(msg.query, limit)
        await this.send({
          type: 'candidates',
          payload: {
            entityType: msg.entityType,
            query: msg.query,
            items: items.map((card) => ({
              ...card,
              favorited: services.favorites.has(msg.entityType, card.entityId),
            })),
            total,
            limit,
          },
        })
        return
      }
    }
  }

  private get period(): Period {
    const stored = this.services.context.globalState.get<unknown>(PERIOD_KEY)
    return isPeriod(stored) ? stored : '24h'
  }

  private get prefs(): DashboardPrefs {
    const stored = this.services.context.globalState.get<Partial<DashboardPrefs>>(PREFS_KEY)
    return { ...DEFAULT_PREFS, ...stored }
  }

  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined
      void this.push()
    }, 250)
  }

  private async push(): Promise<void> {
    const state = await this.buildState()
    await this.send({ type: 'state', state })
  }

  private async buildState(): Promise<DashboardState> {
    const { indexer, settings, favorites, registry, sessions } = this.services
    const period = this.period
    const visible = indexer.getAll().filter((e) => isVisibleEntry(e, settings))
    const live = await this.services.refreshLive()
    const stats = computeStats(visible, live, period)
    const status = indexer.status()

    const groups = buildFavoriteGroups(favorites.list(), registry)
    const favoritedIds = new Set(favorites.listByType('session').map((f) => f.entity_id))
    // Live sessions already starred show their ● on the favorite card; the
    // strip lists the rest (a live session with no transcript yet included).
    const liveCards: FavoriteCard[] = []
    for (const l of live) {
      if (favoritedIds.has(l.sessionId)) continue
      const entry = indexer.get(l.sessionId)
      const folder = l.cwd.split('/').pop() ?? l.cwd
      liveCards.push(
        entry && !entry.missing
          ? sessions.card(entry, l)
          : {
              entityType: 'session',
              entityId: l.sessionId,
              title: l.name || l.sessionId,
              subtitle: folder || null,
              preview: null,
              details: [],
              status: 'starting',
              statusVariant: 'info',
              updatedAt: l.updatedAt ? new Date(l.updatedAt).toISOString() : null,
              group: { key: l.cwd, label: folder },
              meta: { cwd: l.cwd, livePid: l.pid, liveName: l.name },
            }
      )
    }
    const liveIds = new Set(live.map((l) => l.sessionId))
    const suggested = sessions.suggest(SUGGESTED_LIMIT, new Set([...favoritedIds, ...liveIds]))

    const indexValue = status.scanning
      ? `${status.complete} / ${status.total}`
      : status.total === 0
        ? 'empty'
        : String(status.total)
    const indexHint = status.scanning
      ? 'indexing…'
      : status.parseErrors
        ? `${status.parseErrors} unreadable lines`
        : 'up to date'
    const hiddenNote = settings.showSdkSessions ? '' : ' · SDK sessions hidden'
    const tiles: StatTileData[] = [
      { id: 'live', label: 'Live', value: String(stats.live), hint: 'running now' },
      { id: 'active', label: 'Active', value: String(stats.active), hint: `in ${period}` },
      {
        id: 'tokens',
        label: 'Output tokens',
        value: `${stats.approximate ? '≈' : ''}${formatCount(stats.outputTokens)}`,
        hint: `sessions active in ${period}`,
        tooltip:
          'Whole-session totals for sessions active in the period. ≈ while some are still indexing.',
      },
      { id: 'prs', label: 'PRs', value: String(stats.prs), hint: `linked, active in ${period}` },
      {
        id: 'favorites',
        label: 'Favorites',
        value: String(favorites.list().length),
        hint: 'starred sessions',
      },
      {
        id: 'index',
        label: 'Index',
        value: indexValue,
        hint: indexHint,
        tooltip: `${status.total} sessions · ${status.complete} complete · ${status.pending} pending · ${status.fastOnly} head/tail only · ${status.missing} missing${hiddenNote}`,
      },
    ]
    return {
      extensionVersion: this.services.version,
      period,
      stats: tiles,
      index: {
        total: status.total,
        complete: status.complete,
        pending: status.pending,
        fastOnly: status.fastOnly,
        missing: status.missing,
        parseErrors: status.parseErrors,
        scanning: status.scanning,
      },
      prefs: this.prefs,
      groups,
      live: liveCards,
      suggested,
      workspaceKeys: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      browsable: registry.all().map((r) => r.entityType),
    }
  }

  private send(message: HostToWebview): Thenable<boolean> {
    return this.panel.webview.postMessage(message)
  }

  private dispose(): void {
    DashboardPanel.current = undefined
    if (this.pushTimer) clearTimeout(this.pushTimer)
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
