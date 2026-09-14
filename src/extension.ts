import * as vscode from 'vscode'
import { registerCommands } from './commands'
import { Services } from './services'
import { DashboardPanel } from './views/dashboard/DashboardPanel'
import { SessionTreeProvider } from './views/tree/SessionTreeProvider'

/**
 * Activation wires the shared services (output channel, background indexer,
 * favorites store), the sidebar tree, the commands, and the dashboard
 * serializer. The indexer and the favorites file load asynchronously:
 * activation must stay cheap because the command palette activates this
 * extension on first use.
 */
/** What `activate` returns — consumed by the e2e suite, not a public API. */
export interface SessionDeckApi {
  services: Services
  tree: SessionTreeProvider
}

export function activate(context: vscode.ExtensionContext): SessionDeckApi {
  const services = new Services(context)
  const tree = new SessionTreeProvider(services)
  context.subscriptions.push(
    services,
    tree,
    vscode.window.createTreeView('sessionDeck.sessions', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
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
    ...registerCommands(services, tree),
    DashboardPanel.register(services)
  )
  return { services, tree }
}

export function deactivate(): void {
  // Services is disposed through context.subscriptions.
}
