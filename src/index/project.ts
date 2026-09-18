import { basename } from 'node:path'
import type { SessionIndexEntry } from './types'

/** The folder name a session's cwd ends in — what the dashboard groups by. */
export function projectLabel(entry: Pick<SessionIndexEntry, 'cwd' | 'slug'>): string {
  if (entry.cwd) return basename(entry.cwd) || entry.cwd
  // Slug fallback: "-Users-x-projects-demo" → "demo"
  const parts = entry.slug.split('-').filter(Boolean)
  return parts[parts.length - 1] ?? entry.slug
}
