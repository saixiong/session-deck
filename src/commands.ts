import * as vscode from 'vscode'
import { resolveTitle } from './index/records'
import { isSessionId } from './open/SessionOpener'
import type { Services } from './services'
import { DashboardPanel } from './views/dashboard/DashboardPanel'
import type { SessionTreeProvider, TreeNode } from './views/tree/SessionTreeProvider'

/**
 * Every command takes either a tree node (from a menu) or a bare session id
 * (from the palette, the dashboard, or another extension) — `sessionIdOf`
 * normalises that so each command has one body.
 */
export function registerCommands(
  services: Services,
  tree: SessionTreeProvider
): vscode.Disposable[] {
  const { favorites, indexer, opener } = services

  const sessionIdOf = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return isSessionId(arg) ? arg : undefined
    if (typeof arg === 'object' && arg !== null && (arg as TreeNode).kind === 'session') {
      const node = arg as Extract<TreeNode, { kind: 'session' }>
      return node.entry?.sessionId ?? node.favorite?.entity_id
    }
    return undefined
  }

  const labelFor = (sessionId: string): string => {
    const entry = indexer.get(sessionId)
    return entry ? resolveTitle(entry) : sessionId
  }

  const star = async (sessionId: string): Promise<void> => {
    await services.favoritesReady
    await favorites.add({ entityType: 'session', entityId: sessionId, label: labelFor(sessionId) })
  }

  const unstar = async (sessionId: string): Promise<void> => {
    await services.favoritesReady
    await favorites.removeByEntity('session', sessionId)
  }

  return [
    vscode.commands.registerCommand(
      'sessionDeck.openSession',
      async (arg: unknown, prompt?: unknown) => {
        const sessionId = sessionIdOf(arg)
        if (!sessionId) return
        const entry = indexer.get(sessionId)
        const req = {
          sessionId,
          ...(typeof prompt === 'string' ? { prompt } : {}),
          ...(entry?.cwd ? { cwd: entry.cwd } : {}),
          ...(entry ? { title: resolveTitle(entry) } : {}),
        }
        await opener.open(req)
      }
    ),

    vscode.commands.registerCommand('sessionDeck.openSessionWithPrompt', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      if (!sessionId) return
      const prompt = await vscode.window.showInputBox({
        title: `Open "${labelFor(sessionId)}" with a prompt`,
        prompt: 'Typed into the composer, not sent.',
        placeHolder: 'Continue where we left off…',
      })
      if (prompt === undefined) return
      const entry = indexer.get(sessionId)
      await opener.open({
        sessionId,
        prompt,
        ...(entry?.cwd ? { cwd: entry.cwd } : {}),
        ...(entry ? { title: resolveTitle(entry) } : {}),
      })
    }),

    vscode.commands.registerCommand('sessionDeck.openSessionInWindow', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      if (!sessionId) return
      const entry = indexer.get(sessionId)
      await opener.open({ sessionId, target: 'window', ...(entry?.cwd ? { cwd: entry.cwd } : {}) })
    }),

    vscode.commands.registerCommand('sessionDeck.reviewSession', async (arg: unknown) => {
      // Any session, starred or not (Q2): the report is cached the same way.
      const sessionId = sessionIdOf(arg)
      if (!sessionId) return
      await DashboardPanel.show(services).showReview(sessionId, true)
    }),

    vscode.commands.registerCommand('sessionDeck.reviewFavorites', async () => {
      await DashboardPanel.show(services).showReview(null)
    }),

    vscode.commands.registerCommand('sessionDeck.favorite', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      if (sessionId) await star(sessionId)
    }),

    vscode.commands.registerCommand('sessionDeck.unfavorite', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      if (sessionId) await unstar(sessionId)
    }),

    vscode.commands.registerCommand('sessionDeck.toggleFavorite', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      if (!sessionId) return
      if (favorites.has('session', sessionId)) await unstar(sessionId)
      else await star(sessionId)
    }),

    vscode.commands.registerCommand('sessionDeck.favoriteCurrentSession', async () => {
      // "Current" = a live session whose cwd is inside this window's
      // workspace, most recently updated first; ask when there are several.
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
      const live = (await services.refreshLive()).filter((l) =>
        folders.length === 0 ? true : folders.some((f) => l.cwd === f || l.cwd.startsWith(`${f}/`))
      )
      if (live.length === 0) {
        void vscode.window.showInformationMessage(
          'Session Deck: no running Claude Code session found for this workspace.'
        )
        return
      }
      let chosen = live[0]
      if (live.length > 1) {
        const pick = await vscode.window.showQuickPick(
          live.map((l) => ({
            label: labelFor(l.sessionId),
            description: `${l.name} · pid ${l.pid}`,
            detail: l.cwd,
            sessionId: l.sessionId,
          })),
          { placeHolder: 'Several sessions are running here — which one?' }
        )
        if (!pick) return
        chosen = live.find((l) => l.sessionId === pick.sessionId)
      }
      if (!chosen) return
      const already = favorites.has('session', chosen.sessionId)
      if (already) {
        const remove = 'Remove from favorites'
        const choice = await vscode.window.showInformationMessage(
          `"${labelFor(chosen.sessionId)}" is already a favorite.`,
          remove
        )
        if (choice === remove) await unstar(chosen.sessionId)
        return
      }
      await star(chosen.sessionId)
      void vscode.window.setStatusBarMessage(
        `$(star-full) Starred "${labelFor(chosen.sessionId)}"`,
        3000
      )
    }),

    vscode.commands.registerCommand('sessionDeck.copySessionId', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      if (!sessionId) return
      await vscode.env.clipboard.writeText(sessionId)
      void vscode.window.setStatusBarMessage('Session id copied', 2000)
    }),

    vscode.commands.registerCommand('sessionDeck.revealSessionFile', async (arg: unknown) => {
      const sessionId = sessionIdOf(arg)
      const entry = sessionId ? indexer.get(sessionId) : undefined
      if (!entry || entry.missing) return
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.filePath))
    }),

    vscode.commands.registerCommand('sessionDeck.showMore', (key: unknown) => {
      if (typeof key === 'string') tree.showMore(key)
    }),

    vscode.commands.registerCommand('sessionDeck.refreshTree', async () => {
      await indexer.refresh()
      tree.refresh()
    }),
  ]
}
