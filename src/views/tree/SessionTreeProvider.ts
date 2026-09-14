import * as vscode from 'vscode'
import { resolveTitle } from '../../index/records'
import type { SessionIndexEntry } from '../../index/types'
import { projectLabel } from '../../registry/sessionResolver'
import type { Services } from '../../services'
import { formatTimeDistance } from '../../shared/cards'
import type { Favorite } from '../../store/FavoritesStore'

/**
 * The sidebar (spec §7): Favorites (grouped by project) → Live now → Recent
 * (per project, newest first, a page at a time). It is the cheap "star where
 * the user already is" surface: every session row carries an inline star.
 *
 * Visual rule (Snippbot §16.1): a starred row shows the star permanently as
 * its icon; an unstarred row reveals its star only on hover (VS Code's inline
 * action behaviour), so the list is readable without sweeping the mouse.
 */
export type TreeNode =
  | {
      kind: 'section'
      id: 'favorites' | 'live' | 'recent'
      label: string
      icon: string
      count: number
    }
  | { kind: 'project'; section: 'favorites' | 'recent'; key: string; label: string; count: number }
  | {
      kind: 'session'
      section: 'favorites' | 'live' | 'recent'
      entry: SessionIndexEntry | undefined
      favorite: Favorite | undefined
      live: boolean
      liveName?: string
      parentKey: string
    }
  | { kind: 'more'; section: 'recent'; key: string; remaining: number }

const PAGE = 20

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event
  private readonly pageLimits = new Map<string, number>()
  private refreshTimer: NodeJS.Timeout | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly services: Services) {
    this.disposables.push(
      services.onDidChangeIndex(() => this.scheduleRefresh()),
      services.onDidChangeFavorites(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh())
    )
    void services.favoritesReady.then(() => this.scheduleRefresh())
  }

  refresh(): void {
    this.emitter.fire(undefined)
  }

  showMore(key: string): void {
    this.pageLimits.set(key, (this.pageLimits.get(key) ?? PAGE) + PAGE)
    this.refresh()
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.refresh()
    }, 200)
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    const live = await this.services.refreshLive()
    const liveIds = new Set(live.map((l) => l.sessionId))
    const liveNames = new Map(live.map((l) => [l.sessionId, l.name]))
    if (!node) return this.roots(liveIds)
    switch (node.kind) {
      case 'section':
        return this.sectionChildren(node.id, liveIds, liveNames)
      case 'project':
        return this.projectChildren(node, liveIds)
      case 'session':
      case 'more':
        return []
    }
  }

  private roots(liveIds: Set<string>): TreeNode[] {
    const favorites = this.services.favorites.listByType('session')
    const recent = this.services.sessions.recent()
    // Nothing anywhere: let the view's welcome content explain instead of
    // three empty sections.
    if (favorites.length === 0 && recent.length === 0 && liveIds.size === 0) return []
    return [
      {
        kind: 'section',
        id: 'favorites',
        label: 'Favorites',
        icon: 'star-full',
        count: favorites.length,
      },
      { kind: 'section', id: 'live', label: 'Live now', icon: 'pulse', count: liveIds.size },
      { kind: 'section', id: 'recent', label: 'Recent', icon: 'history', count: recent.length },
    ]
  }

  private sectionChildren(
    id: 'favorites' | 'live' | 'recent',
    liveIds: Set<string>,
    liveNames: Map<string, string>
  ): TreeNode[] {
    const { favorites, sessions, indexer } = this.services
    if (id === 'live') {
      return [...liveIds].map((sessionId): TreeNode => {
        const node: Extract<TreeNode, { kind: 'session' }> = {
          kind: 'session',
          section: 'live',
          entry: present(indexer.get(sessionId)),
          favorite: favorites.get('session', sessionId),
          live: true,
          parentKey: 'live',
        }
        const liveName = liveNames.get(sessionId)
        if (liveName) node.liveName = liveName
        return node
      })
    }
    const rows = id === 'favorites' ? favorites.listByType('session') : []
    const entries: Array<{ entry: SessionIndexEntry | undefined; favorite: Favorite | undefined }> =
      id === 'favorites'
        ? rows.map((f) => ({ entry: present(indexer.get(f.entity_id)), favorite: f }))
        : sessions
            .recent()
            .map((entry) => ({ entry, favorite: favorites.get('session', entry.sessionId) }))
    // Group by project; the workspace's project(s) first, then by most recent activity.
    const groups = new Map<
      string,
      { label: string; items: typeof entries; latest: string; inWorkspace: boolean }
    >()
    for (const item of entries) {
      const key = item.entry ? item.entry.cwd || item.entry.slug : 'missing'
      const label = item.entry ? projectLabel(item.entry) : 'No longer on disk'
      const group = groups.get(key) ?? {
        label,
        items: [],
        latest: '',
        inWorkspace: item.entry ? sessions.inWorkspace(item.entry) : false,
      }
      group.items.push(item)
      if (item.entry && item.entry.lastActiveAt > group.latest)
        group.latest = item.entry.lastActiveAt
      groups.set(key, group)
    }
    return [...groups.entries()]
      .sort(
        ([, a], [, b]) =>
          Number(b.inWorkspace) - Number(a.inWorkspace) || (a.latest < b.latest ? 1 : -1)
      )
      .map(([key, g]) => ({
        kind: 'project' as const,
        section: id,
        key,
        label: g.label,
        count: g.items.length,
      }))
  }

  private projectChildren(
    node: Extract<TreeNode, { kind: 'project' }>,
    liveIds: Set<string>
  ): TreeNode[] {
    const { favorites, sessions, indexer } = this.services
    if (node.section === 'favorites') {
      return favorites
        .listByType('session')
        .map((f) => ({ entry: present(indexer.get(f.entity_id)), favorite: f }))
        .filter(({ entry }) => (entry ? entry.cwd || entry.slug : 'missing') === node.key)
        .map(({ entry, favorite }) => ({
          kind: 'session' as const,
          section: 'favorites' as const,
          entry,
          favorite,
          live: liveIds.has(favorite.entity_id),
          parentKey: node.key,
        }))
    }
    const all = sessions.recent().filter((e) => (e.cwd || e.slug) === node.key)
    const limit = this.pageLimits.get(node.key) ?? PAGE
    const page: TreeNode[] = all.slice(0, limit).map((entry) => ({
      kind: 'session' as const,
      section: 'recent' as const,
      entry,
      favorite: favorites.get('session', entry.sessionId),
      live: liveIds.has(entry.sessionId),
      parentKey: node.key,
    }))
    if (all.length > limit)
      page.push({ kind: 'more', section: 'recent', key: node.key, remaining: all.length - limit })
    return page
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(
          node.label,
          node.id === 'favorites' || node.id === 'live'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
        )
        item.id = `section:${node.id}`
        item.description = String(node.count)
        item.iconPath = new vscode.ThemeIcon(node.icon)
        item.contextValue = `section:${node.id}`
        return item
      }
      case 'project': {
        const item = new vscode.TreeItem(
          node.label,
          node.section === 'favorites'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
        )
        item.id = `${node.section}:project:${node.key}`
        item.description = String(node.count)
        item.iconPath = new vscode.ThemeIcon('folder')
        item.contextValue = 'project'
        item.tooltip = node.key
        return item
      }
      case 'more': {
        const item = new vscode.TreeItem(`Show ${Math.min(PAGE, node.remaining)} more…`)
        item.id = `more:${node.key}`
        item.iconPath = new vscode.ThemeIcon('ellipsis')
        item.command = {
          command: 'sessionDeck.showMore',
          title: 'Show more',
          arguments: [node.key],
        }
        item.contextValue = 'more'
        return item
      }
      case 'session':
        return this.sessionItem(node)
    }
  }

  private sessionItem(node: Extract<TreeNode, { kind: 'session' }>): vscode.TreeItem {
    const { entry, favorite } = node
    const sessionId = entry?.sessionId ?? favorite?.entity_id ?? ''
    const title = entry ? resolveTitle(entry) : (favorite?.label ?? node.liveName ?? sessionId)
    const item = new vscode.TreeItem(title)
    item.id = `${node.section}:${node.parentKey}:${sessionId}`
    const starred = favorite !== undefined
    // A live session with no transcript yet is starting, not gone.
    const missing = entry === undefined && !node.live
    const parts: string[] = []
    if (entry) {
      parts.push(formatTimeDistance(entry.lastActiveAt))
      if (node.section !== 'recent') parts.push(projectLabel(entry))
      const branch = entry.gitBranches[entry.gitBranches.length - 1]
      if (branch && node.section === 'recent') parts.push(branch)
    } else if (node.live) {
      parts.push('starting…')
    } else {
      parts.push('no longer on disk')
    }
    item.description = parts.filter(Boolean).join(' · ')
    item.iconPath = new vscode.ThemeIcon(
      missing ? 'warning' : node.live ? 'pulse' : starred ? 'star-full' : 'comment-discussion',
      missing
        ? new vscode.ThemeColor('list.warningForeground')
        : node.live
          ? new vscode.ThemeColor('charts.green')
          : starred
            ? new vscode.ThemeColor('charts.yellow')
            : undefined
    )
    item.contextValue = `session:${starred ? 'starred' : 'unstarred'}${missing ? ':missing' : ''}${node.live ? ':live' : ''}`
    item.tooltip = this.tooltip(node, title)
    if (!missing) {
      item.command = {
        command: 'sessionDeck.openSession',
        title: 'Open session',
        arguments: [sessionId],
      }
    }
    return item
  }

  private tooltip(
    node: Extract<TreeNode, { kind: 'session' }>,
    title: string
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true)
    md.isTrusted = false
    md.appendMarkdown(`**${escapeMd(title)}**\n\n`)
    const { entry, favorite } = node
    if (entry) {
      md.appendMarkdown(`$(folder) ${escapeMd(entry.cwd || entry.slug)}  \n`)
      if (entry.gitBranches.length)
        md.appendMarkdown(`$(git-branch) ${escapeMd(entry.gitBranches.join(', '))}  \n`)
      md.appendMarkdown(
        `$(history) ${escapeMd(entry.lastActiveAt.slice(0, 16).replace('T', ' '))} · ${entry.userTurns} turns · ${entry.toolUses} tool calls  \n`
      )
      if (entry.prLinks.length)
        md.appendMarkdown(
          `$(git-pull-request) ${entry.prLinks.map((p) => `#${p.number}`).join(', ')}  \n`
        )
      if (entry.preview) md.appendMarkdown(`\n> ${escapeMd(entry.preview)}\n`)
    } else {
      md.appendMarkdown(`This session's transcript is no longer on disk.  \n`)
    }
    if (favorite?.note) md.appendMarkdown(`\n$(note) ${escapeMd(favorite.note)}`)
    md.appendMarkdown(`\n\n\`${node.entry?.sessionId ?? favorite?.entity_id ?? ''}\``)
    return md
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.emitter.dispose()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}

/** An index entry that is actually on disk; `missing` rows read as absent. */
function present(entry: SessionIndexEntry | undefined): SessionIndexEntry | undefined {
  return entry && !entry.missing ? entry : undefined
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!>|])/g, '\\$1')
}
