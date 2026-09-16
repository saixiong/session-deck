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
  const treeView = vscode.window.createTreeView('sessionDeck.sessions', {
    treeDataProvider: tree,
    showCollapseAll: true,
  })
  // Clicking the activity-bar icon should land you on the deck, not on a tree
  // of session names with the dashboard still one command away. The panel is
  // revealed with `preserveFocus` so the sidebar you just clicked keeps the
  // focus, and the whole behaviour is one setting away from off.
  const openDeckWithSidebar = () => {
    const enabled = vscode.workspace
      .getConfiguration('sessionDeck')
      .get<boolean>('openDashboardWithSidebar', true)
    if (enabled) DashboardPanel.show(services, { preserveFocus: true })
  }
  // The first click on the icon is what activates this extension, and
  // `onDidChangeVisibility` reports changes, not the state on arrival — so the
  // one case the user actually asked about needs the check below. `show` is
  // idempotent, so a view that is already visible and then fires the event
  // once more costs a reveal, not a second panel.
  if (treeView.visible) openDeckWithSidebar()
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) openDeckWithSidebar()
    })
  )
  context.subscriptions.push(
    services,
    tree,
    treeView,
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
