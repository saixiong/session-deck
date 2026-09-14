import * as vscode from 'vscode'
import { DashboardPanel } from './views/dashboard/DashboardPanel'

/**
 * Activation wires three things: the dashboard command, the sidebar view (an
 * empty provider for now so the viewsWelcome content renders), and nothing
 * else. Indexer, favorites store and analyser are added by P1–P4 and must be
 * constructed lazily — activation has to stay cheap because the command
 * palette activates this extension on first use.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionDeck.openDashboard', () => {
      DashboardPanel.show(context)
    }),
    vscode.window.registerTreeDataProvider('sessionDeck.sessions', new EmptySessionsProvider())
  )
}

export function deactivate(): void {
  // Nothing to tear down yet; the indexer's background pass will hook in here (P1).
}

/** P0 placeholder. P2 replaces it with SessionTreeProvider. */
class EmptySessionsProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element
  }
  getChildren(): never[] {
    return []
  }
}
