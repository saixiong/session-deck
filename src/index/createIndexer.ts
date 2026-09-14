import { join } from 'node:path'
import * as vscode from 'vscode'
import { expandHome } from '../util/paths'
import { SessionIndexer } from './SessionIndexer'
import type { SessionIndexEntry } from './types'

/**
 * The vscode-aware seam around SessionIndexer: settings in, indexer out.
 * Everything below reads configuration once; a settings change that affects
 * indexing (projects dir, size cap, hidden producers) recreates the indexer
 * via `extension.ts` rather than mutating a live one.
 */
export interface IndexerSettings {
  projectsDir: string
  sessionsDir: string
  fullTierMaxBytes: number
  showSdkSessions: boolean
}

export function readIndexerSettings(): IndexerSettings {
  const config = vscode.workspace.getConfiguration('sessionDeck')
  const projectsDir = expandHome(config.get<string>('claudeProjectsDir', '~/.claude/projects'))
  return {
    projectsDir,
    // The sessions dir is a sibling of projects/ in the same config dir.
    sessionsDir: join(projectsDir, '..', 'sessions'),
    fullTierMaxBytes: Math.max(16, config.get<number>('indexLargeFilesMB', 512)) * 1024 * 1024,
    showSdkSessions: config.get<boolean>('showSdkSessions', false),
  }
}

/** Producers hidden by default (spec D4). Exported so the tree and resolvers apply the same rule. */
export function isVisibleEntry(
  entry: SessionIndexEntry,
  settings: Pick<IndexerSettings, 'showSdkSessions'>
): boolean {
  return settings.showSdkSessions || entry.entrypoint !== 'sdk-cli'
}

export function createIndexer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): SessionIndexer {
  const settings = readIndexerSettings()
  return new SessionIndexer({
    projectsDir: settings.projectsDir,
    sessionsDir: settings.sessionsDir,
    cachePath: join(context.globalStorageUri.fsPath, 'index.json'),
    fullTierMaxBytes: settings.fullTierMaxBytes,
    wantsFullTier: (entry) => isVisibleEntry(entry, settings),
    log: (message) => output.appendLine(`[index] ${message}`),
  })
}

/** Settings keys whose change requires a new indexer. */
export const INDEXER_SETTING_KEYS = [
  'sessionDeck.claudeProjectsDir',
  'sessionDeck.indexLargeFilesMB',
  'sessionDeck.showSdkSessions',
]
