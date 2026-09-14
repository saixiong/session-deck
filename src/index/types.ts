/**
 * Everything the dashboard and the sidebar show about a session comes from
 * one of these entries — never from a parse at render time (spec §4.3).
 */
export interface PrLink {
  number: number
  url: string
  repo: string
}

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export interface SessionIndexEntry {
  sessionId: string
  /** The `~/.claude/projects/<slug>` directory name. */
  slug: string
  filePath: string
  cwd: string
  gitBranches: string[]
  /** `claude-vscode`, `sdk-cli`, `cli`, … — read from the first user/assistant record. */
  entrypoint: string
  version: string
  /** From a `custom-title` record (Rename Session Tab / `/rename`). Wins over aiTitle. */
  customTitle: string | null
  /** From the last `ai-title` record. */
  aiTitle: string | null
  firstPrompt: string
  lastPrompt: string | null
  /** Tail of the last assistant text block, markdown-stripped, clipped. */
  preview: string | null
  createdAt: string
  lastActiveAt: string
  messageCount: number
  userTurns: number
  toolUses: number
  compactions: number
  tokens: TokenTotals
  models: string[]
  prLinks: PrLink[]
  // bookkeeping
  size: number
  mtimeMs: number
  /** Byte offset the full pass has consumed. Equal to `size` once complete. */
  parsedTo: number
  /** true = head+tail only; counts and tokens are partial until the full pass finishes. */
  fast: boolean
  parseErrors: number
  missing: boolean
}

export interface IndexSnapshot {
  version: 1
  sessions: Record<string, SessionIndexEntry>
}

export const INDEX_VERSION = 1 as const

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}
