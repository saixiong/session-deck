import * as vscode from 'vscode'
import { Services } from './services'
import { DashboardPanel } from './views/dashboard/DashboardPanel'

/**
 * Activation wires the shared services (output channel + background indexer),
 * the commands, the sidebar view, and the dashboard serializer. The indexer
 * starts asynchronously: activation must stay cheap because the command
 * palette activates this extension on first use.
 */
export function activate(context: vscode.ExtensionContext): void {
  const services = new Services(context)
  context.subscriptions.push(
    services,
    vscode.commands.registerCommand('sessionDeck.openDashboard', () => {
      DashboardPanel.show(services)
    }),
    vscode.commands.registerCommand('sessionDeck.reindex', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Session Deck: re-indexing sessions…',
        },
        () => services.indexer.reindex()
      )
    }),
    vscode.commands.registerCommand('sessionDeck.showOutput', () => services.output.show()),
    vscode.window.registerTreeDataProvider('sessionDeck.sessions', new EmptySessionsProvider()),
    DashboardPanel.register(services)
  )
}

export function deactivate(): void {
  // Services is disposed through context.subscriptions.
}

/** P1 placeholder. P2 replaces it with SessionTreeProvider. */
class EmptySessionsProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element
  }
  getChildren(): never[] {
    return []
  }
}
