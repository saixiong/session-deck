import type { PrLink, SessionIndexEntry, TokenTotals } from './types'

/**
 * Interpreters for the record types in ~/.claude/projects/<slug>/<id>.jsonl
 * (spec §3.2). Every function here is pure and tolerant: an unknown type or a
 * missing field yields "nothing learned", never a throw. The layout is not a
 * published contract, and a renamed field must degrade a card, not crash the
 * index.
 */

export type Rec = Record<string, unknown>

export const PREVIEW_MAX_CHARS = 280
export const PROMPT_MAX_CHARS = 200
const ELLIPSIS = '…'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function message(rec: Rec): Rec | undefined {
  const m = rec['message']
  return typeof m === 'object' && m !== null ? (m as Rec) : undefined
}

export function recordType(rec: Rec): string | undefined {
  return str(rec['type'])
}

/** A real turn of the conversation: user or assistant, not meta, not a subagent side-chain. */
export function isConversational(rec: Rec): boolean {
  const type = recordType(rec)
  if (type !== 'user' && type !== 'assistant') return false
  if (rec['isMeta'] === true || rec['isSidechain'] === true) return false
  return true
}

/** Text blocks of a message, joined. Tool calls, tool results and thinking are excluded. */
export function textOf(rec: Rec): string {
  const m = message(rec)
  if (!m) return ''
  const content = m['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Rec
      if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
    }
  }
  return parts.join('\n')
}

/** Count of tool_use blocks in an assistant message. */
export function toolUsesOf(rec: Rec): number {
  const content = message(rec)?.['content']
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as Rec)['type'] === 'tool_use') n++
  }
  return n
}

const SYSTEM_TAG = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const COMPACTION_DIGEST_PREFIX = 'This session is being continued from a previous conversation'

/**
 * A prompt the human actually typed: a user record whose text does not start
 * with an injected tag (`<system-reminder>`, `<command-name>`,
 * `<local-command-stdout>`...) and is not a compaction digest.
 */
export function humanPromptOf(rec: Rec): string | undefined {
  if (recordType(rec) !== 'user' || rec['isMeta'] === true || rec['isSidechain'] === true) {
    return undefined
  }
  const text = textOf(rec).replace(SYSTEM_TAG, '').trim()
  if (!text || text.startsWith('<')) return undefined
  if (text.startsWith(COMPACTION_DIGEST_PREFIX)) return undefined
  return text
}

/** The tail of an assistant reply, markdown-stripped, for the card preview. */
export function previewOf(rec: Rec): string | undefined {
  if (recordType(rec) !== 'assistant' || rec['isSidechain'] === true) return undefined
  const text = stripMarkdown(textOf(rec))
  return text ? clipTail(text, PREVIEW_MAX_CHARS) : undefined
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = text.slice(text.length - max + 1)
  // Start on a word boundary when one is near, so the clip does not open mid-word.
  const space = cut.indexOf(' ')
  if (space > 0 && space < 24) cut = cut.slice(space + 1)
  return `${ELLIPSIS}${cut}`
}

export function clipHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}${ELLIPSIS}`
}

export function tokensOf(rec: Rec): TokenTotals | undefined {
  const usage = message(rec)?.['usage']
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Rec
  return {
    input: num(u['input_tokens']),
    output: num(u['output_tokens']),
    cacheRead: num(u['cache_read_input_tokens']),
    cacheCreate: num(u['cache_creation_input_tokens']),
  }
}

export function modelOf(rec: Rec): string | undefined {
  const model = str(message(rec)?.['model'])
  // `<synthetic>` marks host-generated assistant records (compaction notices etc.).
  return model && !model.startsWith('<') ? model : undefined
}

export function prLinkOf(rec: Rec): PrLink | undefined {
  if (recordType(rec) !== 'pr-link') return undefined
  const url = str(rec['prUrl'])
  if (!url) return undefined
  return { number: num(rec['prNumber']), url, repo: str(rec['prRepository']) ?? '' }
}

export function timestampOf(rec: Rec): string | undefined {
  return str(rec['timestamp'])
}

/** custom-title > last ai-title > first prompt > placeholder (spec §5). */
export function resolveTitle(
  entry: Pick<SessionIndexEntry, 'customTitle' | 'aiTitle' | 'firstPrompt'>
): string {
  return (
    entry.customTitle ??
    entry.aiTitle ??
    (entry.firstPrompt ? clipHead(entry.firstPrompt, 80) : 'Untitled session')
  )
}

/**
 * Apply one record to an entry. This is the single accumulator both tiers use:
 * the fast tier feeds it head and tail lines, the full pass feeds it every
 * line from `parsedTo`. Order-sensitive fields (titles, lastActiveAt, preview)
 * take the latest value seen, which is right for both because both feed lines
 * in file order.
 */
export function applyRecord(entry: SessionIndexEntry, rec: Rec): void {
  const type = recordType(rec)
  switch (type) {
    case 'user':
    case 'assistant': {
      const cwd = str(rec['cwd'])
      if (cwd && !entry.cwd) entry.cwd = cwd
      const branch = str(rec['gitBranch'])
      if (branch && !entry.gitBranches.includes(branch)) entry.gitBranches.push(branch)
      const entrypoint = str(rec['entrypoint'])
      if (entrypoint && !entry.entrypoint) entry.entrypoint = entrypoint
      const version = str(rec['version'])
      if (version) entry.version = version
      const ts = timestampOf(rec)
      if (ts) {
        if (!entry.createdAt || ts < entry.createdAt) entry.createdAt = ts
        if (ts > entry.lastActiveAt) entry.lastActiveAt = ts
      }
      if (!isConversational(rec)) return
      entry.messageCount++
      if (type === 'user') {
        const prompt = humanPromptOf(rec)
        if (prompt) {
          entry.userTurns++
          if (!entry.firstPrompt)
            entry.firstPrompt = clipHead(prompt.replace(/\s+/g, ' '), PROMPT_MAX_CHARS)
        }
      } else {
        entry.toolUses += toolUsesOf(rec)
        const tokens = tokensOf(rec)
        if (tokens) {
          entry.tokens.input += tokens.input
          entry.tokens.output += tokens.output
          entry.tokens.cacheRead += tokens.cacheRead
          entry.tokens.cacheCreate += tokens.cacheCreate
        }
        const model = modelOf(rec)
        if (model && !entry.models.includes(model)) entry.models.push(model)
        const preview = previewOf(rec)
        if (preview) entry.preview = preview
      }
      return
    }
    case 'custom-title': {
      const title = str(rec['customTitle'])
      if (title) entry.customTitle = title
      return
    }
    case 'ai-title': {
      const title = str(rec['aiTitle'])
      if (title) entry.aiTitle = title
      return
    }
    case 'last-prompt': {
      const prompt = str(rec['lastPrompt'])
      if (prompt) entry.lastPrompt = clipHead(prompt.replace(/\s+/g, ' '), PROMPT_MAX_CHARS)
      return
    }
    case 'pr-link': {
      const link = prLinkOf(rec)
      if (link && !entry.prLinks.some((p) => p.url === link.url)) entry.prLinks.push(link)
      return
    }
    case 'system': {
      if (rec['subtype'] === 'compact_boundary') entry.compactions++
      return
    }
    case undefined:
    default:
      return
  }
}
