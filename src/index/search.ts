import { resolveTitle } from './records'
import type { SessionIndexEntry } from './types'
import { projectLabel } from './project'

/**
 * The one matcher both surfaces use (SPEC_SEARCH S1, S3): the dashboard's
 * search box and the sidebar's filter must find the same sessions for the
 * same words, so there is exactly one place that decides what a word can
 * match. Words are ANDed, case-insensitive, substring anywhere in a field;
 * nothing fuzzy, nothing ranked — recency, which every list already uses,
 * orders the results.
 */

/** Lowercased words; empty for an empty or whitespace query, which matches everything. */
export function normaliseQuery(query: string | null | undefined): string[] {
  return (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** Every word occurs in at least one of the texts. */
export function matchesTexts(
  texts: ReadonlyArray<string | null | undefined>,
  words: readonly string[]
): boolean {
  if (words.length === 0) return true
  const haystack = texts.filter((t): t is string => !!t).map((t) => t.toLowerCase())
  return words.every((w) => haystack.some((t) => t.includes(w)))
}

const ID_PREFIX_MIN = 4

/**
 * What an indexed session can be found by: its title, first and last prompt,
 * the preview of its last reply, its project, branches and PRs (as `#42`),
 * and its id — by prefix only, and only for four or more characters, so `a`
 * does not match every session on the machine.
 */
export function matchesQuery(
  entry: Pick<
    SessionIndexEntry,
    | 'sessionId'
    | 'customTitle'
    | 'aiTitle'
    | 'firstPrompt'
    | 'lastPrompt'
    | 'preview'
    | 'cwd'
    | 'slug'
    | 'gitBranches'
    | 'prLinks'
  >,
  words: readonly string[]
): boolean {
  if (words.length === 0) return true
  const texts = [
    resolveTitle(entry),
    entry.firstPrompt,
    entry.lastPrompt,
    entry.preview,
    projectLabel(entry),
    ...entry.gitBranches,
    ...entry.prLinks.map((p) => `#${p.number}`),
  ]
  const id = entry.sessionId.toLowerCase()
  return words.every(
    (w) =>
      texts.some((t) => !!t && t.toLowerCase().includes(w)) ||
      (w.length >= ID_PREFIX_MIN && id.startsWith(w))
  )
}

/** What a content index must offer the matcher (S6): which words a session's transcript contains. */
export interface ContentLookup {
  wordsIn(sessionId: string, words: readonly string[]): string[]
}

export interface SessionMatch {
  hit: boolean
  /** The words that only the transcript satisfied — empty when metadata alone matched. */
  viaContent: string[]
}

/**
 * The S3 rule with the transcript as one more field (S6): a word counts if it
 * is in any metadata field or anywhere in the session's indexed text. A word
 * found only in the text is reported, so a result can say where it matched.
 */
export function matchSession(
  entry: Parameters<typeof matchesQuery>[0],
  words: readonly string[],
  content?: ContentLookup
): SessionMatch {
  if (words.length === 0) return { hit: true, viaContent: [] }
  const missing = words.filter((w) => !matchesQuery(entry, [w]))
  if (missing.length === 0) return { hit: true, viaContent: [] }
  if (!content) return { hit: false, viaContent: [] }
  const viaContent = content.wordsIn(entry.sessionId, missing)
  return { hit: viaContent.length === missing.length, viaContent }
}
