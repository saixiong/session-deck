import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runClaude } from '../analyze/ClaudeCli'
import { BoardStore } from '../store/BoardStore'
import { itemsOf, KIND_LABELS, promptForItems } from '../shared/board'
import type { BoardItemKind } from '../shared/board'
import { promptForItem } from '../shared/review'
import { ReviewRunner } from '../analyze/ReviewRunner'
import { ReviewStore } from '../analyze/ReviewStore'
import { buildTranscript } from '../analyze/transcript'
import { resolveTitle } from '../index/records'
import { SessionIndexer } from '../index/SessionIndexer'
import type { SessionIndexEntry } from '../index/types'
import { projectLabel } from '../registry/sessionResolver'
import { formatTimeDistance } from '../shared/cards'
import { FavoritesStore } from '../store/FavoritesStore'
import { expandHome } from '../util/paths'
import { findClaudeCli } from './findClaude'

/**
 * The `/session-deck` skill's engine (spec §11 P6, Q4). Same stores, same
 * analyser, same files as the extension — this binary is built from the
 * extension's modules, so a review written here renders in the modal
 * unchanged and vice versa. No vscode imports anywhere below.
 *
 *   session-deck list [--json]
 *   session-deck review [<id>|all] [--run] [--force] [--model <alias>] [--json]
 *   session-deck star <id> | unstar <id>
 *   session-deck show <id>            one cached report in full
 *   session-deck board [--kind <k>] [--all] [--json] [--prompt <session-id>]
 */
interface Env {
  dataDir: string
  projectsDir: string
  sessionsDir: string
}

function env(): Env {
  const dataDir = expandHome(process.env['SESSION_DECK_DATA_DIR'] ?? '~/.session-deck')
  const projectsDir = expandHome(process.env['SESSION_DECK_PROJECTS_DIR'] ?? '~/.claude/projects')
  return { dataDir, projectsDir, sessionsDir: join(projectsDir, '..', 'sessions') }
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}

async function openIndex(e: Env): Promise<SessionIndexer> {
  const indexer = new SessionIndexer({
    projectsDir: e.projectsDir,
    sessionsDir: e.sessionsDir,
    cachePath: join(e.dataDir, 'cache', 'index.json'),
    fullTierMaxBytes: 512 * 1024 * 1024,
    wantsFullTier: (entry) => entry.entrypoint !== 'sdk-cli',
  })
  await indexer.start()
  return indexer
}

async function openFavorites(e: Env): Promise<FavoritesStore> {
  const store = new FavoritesStore(join(e.dataDir, 'favorites.json'))
  await store.load()
  return store
}

async function openBoard(e: Env): Promise<BoardStore> {
  const store = new BoardStore(join(e.dataDir, 'board.json'))
  await store.load()
  return store
}

async function openReviews(e: Env): Promise<ReviewStore> {
  const store = new ReviewStore(join(e.dataDir, 'reviews'))
  await store.load()
  return store
}

function line(
  entry: SessionIndexEntry | undefined,
  label: string,
  id: string,
  priority?: string
): string {
  if (!entry || entry.missing) return `  ✗ ${label}  [${id.slice(0, 8)}]  (no longer on disk)`
  const parts = [
    projectLabel(entry),
    entry.gitBranches[entry.gitBranches.length - 1],
    formatTimeDistance(entry.lastActiveAt),
  ].filter(Boolean)
  return `  ★ ${resolveTitle(entry)}  [${id.slice(0, 8)}]  ${parts.join(' · ')}${priority ? `  → ${priority}` : ''}`
}

async function cmdList(e: Env, json: boolean): Promise<number> {
  const [favorites, reviews, indexer] = await Promise.all([
    openFavorites(e),
    openReviews(e),
    openIndex(e),
  ])
  const rows = favorites.listByType('session').map((f) => {
    const entry = indexer.get(f.entity_id)
    const review = reviews.get(f.entity_id)
    return { id: f.entity_id, label: f.label, entry, review }
  })
  await indexer.dispose()
  if (json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          session_id: r.id,
          title: r.entry ? resolveTitle(r.entry) : r.label,
          project: r.entry?.cwd ?? null,
          branch: r.entry?.gitBranches.at(-1) ?? null,
          last_active: r.entry?.lastActiveAt ?? null,
          missing: !r.entry || r.entry.missing,
          priority: r.review?.priority ?? null,
          priority_label: r.review?.priority_label ?? null,
          completion: r.review?.completion ?? null,
          reviewed_at: r.review?.analyzed_at ?? null,
        })),
        null,
        2
      )
    )
    return 0
  }
  if (rows.length === 0) {
    console.log('No favorites yet. Star one with: session-deck star <session-id>')
    return 0
  }
  console.log(`Favorites (${rows.length}):`)
  for (const r of rows) {
    const prio = r.review
      ? `${r.review.priority} ${r.review.priority_label}${r.review.completion !== null ? ` · ${r.review.completion}%` : ''}`
      : undefined
    console.log(line(r.entry, r.label, r.id, prio))
  }
  return 0
}

function printReview(r: ReturnType<ReviewStore['get']>, stale: boolean): void {
  if (!r) return
  console.log(
    `\n${r.title}  [${r.conversation_id.slice(0, 8)}]  priority ${r.priority} ${r.priority_label}${stale ? '  (out of date)' : ''}`
  )
  console.log(`  ${r.summary}`)
  console.log(`  why: ${r.priority_reason}`)
  if (r.completion !== null)
    console.log(
      `  complete: ${r.completion}%${r.completion_reason ? ` — ${r.completion_reason}` : ''}`
    )
  if (r.done.length) console.log(`  done:\n${r.done.map((d) => `    - ${d}`).join('\n')}`)
  if (r.next_steps.length)
    console.log(`  still to do:\n${r.next_steps.map((d) => `    - ${d}`).join('\n')}`)
  if (r.blockers.length)
    console.log(`  blocked on:\n${r.blockers.map((d) => `    - ${d}`).join('\n')}`)
  if (r.options.length) {
    console.log('  directions:')
    for (const o of r.options)
      console.log(`    - ${o.label}: ${o.description}\n      prompt: ${o.prompt}`)
  }
  console.log(
    `  ${r.model} · ${formatTimeDistance(r.analyzed_at)}${typeof r.cost_usd === 'number' ? ` · $${r.cost_usd.toFixed(3)}` : ''}`
  )
}

async function cmdReview(e: Env, args: string[]): Promise<number> {
  const json = flag(args, '--json')
  const run = flag(args, '--run')
  const force = flag(args, '--force')
  const model = option(args, '--model') ?? process.env['SESSION_DECK_MODEL'] ?? 'sonnet'
  const target = args[0] ?? 'all'
  const [favorites, reviews, indexer] = await Promise.all([
    openFavorites(e),
    openReviews(e),
    openIndex(e),
  ])
  await indexer.whenIdle()
  const ids = target === 'all' ? favorites.listByType('session').map((f) => f.entity_id) : [target]
  if (ids.length === 0) {
    console.log('No favorites to review. Star one first, or pass a session id.')
    await indexer.dispose()
    return 0
  }
  const runner = new ReviewRunner({
    getEntry: (id) => indexer.get(id),
    buildTranscript: (entry) => buildTranscript(entry),
    callModel: async ({ prompt, systemPrompt, schema, signal }) => {
      const cli = process.env['SESSION_DECK_CLAUDE'] ?? (await findClaudeCli())
      if (!cli)
        return {
          ok: false,
          structured: undefined,
          resultText: undefined,
          costUsd: null,
          durationMs: null,
          errorText: 'no claude CLI found (set SESSION_DECK_CLAUDE)',
        }
      const cwd = join(e.dataDir, 'cache', 'review-cwd')
      await mkdir(cwd, { recursive: true })
      return runClaude({
        cliPath: cli,
        prompt,
        systemPrompt,
        schema,
        model,
        cwd,
        timeoutMs: 180_000,
        signal,
      })
    },
    store: reviews,
    model,
    concurrency: 2,
    log: (m) => console.error(`  ${m}`),
  })
  let exit = 0
  if (run) {
    runner.onProgress((p) => {
      if (json) return
      for (const id of p.ids) {
        if (p.status[id] === 'running')
          process.stderr.write(
            `  analysing ${resolveTitle(indexer.get(id) ?? { customTitle: null, aiTitle: null, firstPrompt: id })}…\n`
          )
      }
    })
    const progress = await runner.analyze(ids, { force })
    if (!json)
      console.error(
        `  analysed ${progress.done}, failed ${progress.failed}, $${progress.cost_usd.toFixed(3)}`
      )
    for (const [id, err] of Object.entries(progress.errors))
      console.error(`  ${id.slice(0, 8)}: ${err}`)
    if (progress.failed) exit = 1
  }
  const reports = ids.map((id) => ({ id, review: reviews.get(id), entry: indexer.get(id) }))
  if (json) {
    console.log(
      JSON.stringify(
        reports.map((r) =>
          r.review
            ? { ...r.review, stale: runner.isStale(r.review, r.entry) }
            : { conversation_id: r.id, missing: true }
        ),
        null,
        2
      )
    )
  } else {
    for (const r of reports) {
      if (!r.review) {
        console.log(
          `\n${r.entry ? resolveTitle(r.entry) : r.id}  [${r.id.slice(0, 8)}]  not reviewed yet${run ? '' : ' — add --run to analyse'}`
        )
        continue
      }
      printReview(r.review, runner.isStale(r.review, r.entry))
    }
  }
  await indexer.dispose()
  return exit
}

/**
 * The Board in the terminal (SPEC_BOARD B7/B8): the same rows the dashboard
 * shows, from the same files. Read-only apart from `--prompt`, which composes
 * the seed prompt for a session's open items so the skill can hand it over.
 */
async function cmdBoard(e: Env, args: string[]): Promise<number> {
  const json = flag(args, '--json')
  const all = flag(args, '--all')
  const promptFor = option(args, '--prompt')
  const kind = option(args, '--kind') as BoardItemKind | undefined
  const [favorites, reviews, board, indexer] = await Promise.all([
    openFavorites(e),
    openReviews(e),
    openBoard(e),
    openIndex(e),
  ])
  const rows = favorites
    .listByType('session')
    .flatMap((f) => {
      const review = reviews.get(f.entity_id)
      if (!review) return []
      const entry = indexer.get(f.entity_id)
      const title = entry && !entry.missing ? resolveTitle(entry) : f.label
      return itemsOf(review).map((item) => ({
        sessionId: f.entity_id,
        title,
        priority: review.priority,
        item,
        state: board.get(f.entity_id, item.id)?.state ?? null,
      }))
    })
    .filter(
      (r) => (all || r.state === null || r.state === 'seeded') && (!kind || r.item.kind === kind)
    )
    .sort((a, b) => b.priority - a.priority)
  await indexer.dispose()
  board.dispose()

  if (promptFor) {
    const mine = rows.filter((r) => r.sessionId === promptFor || r.sessionId.startsWith(promptFor))
    if (mine.length === 0) {
      console.error(`No open board items for ${promptFor}.`)
      return 1
    }
    const texts = mine.map((r) => r.item.text)
    console.log(texts.length === 1 ? promptForItem('next_step', texts[0]!) : promptForItems(texts))
    return 0
  }
  if (json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          session_id: r.sessionId,
          title: r.title,
          item_id: r.item.id,
          text: r.item.text,
          kind: r.item.kind,
          source: r.item.source,
          effort: r.item.effort,
          state: r.state,
        })),
        null,
        2
      )
    )
    return 0
  }
  if (rows.length === 0) {
    console.log('Nothing outstanding. Review a starred session to fill the board.')
    return 0
  }
  let current = ''
  console.log(`Board (${rows.length} item${rows.length === 1 ? '' : 's'}):`)
  for (const r of rows) {
    if (r.title !== current) {
      current = r.title
      console.log(`\n  ${current}  [${r.sessionId.slice(0, 8)}]`)
    }
    const tags = [KIND_LABELS[r.item.kind], r.item.source === 'blocker' ? 'blocked' : '', r.state]
      .filter(Boolean)
      .join(' · ')
    console.log(`    - ${r.item.text}  (${tags})`)
  }
  return 0
}

async function cmdStar(e: Env, id: string | undefined, on: boolean): Promise<number> {
  if (!id) {
    console.error('usage: session-deck star|unstar <session-id>')
    return 2
  }
  const favorites = await openFavorites(e)
  if (!on) {
    const removed = await favorites.removeByEntity('session', id)
    console.log(
      removed
        ? `Removed ${id.slice(0, 8)} from favorites.`
        : `${id.slice(0, 8)} was not a favorite.`
    )
    return 0
  }
  const indexer = await openIndex(e)
  const entry = indexer.get(id)
  await indexer.dispose()
  if (!entry) {
    console.error(`No session ${id} under ${e.projectsDir}.`)
    return 1
  }
  await favorites.add({ entityType: 'session', entityId: id, label: resolveTitle(entry) })
  console.log(`Starred "${resolveTitle(entry)}" [${id.slice(0, 8)}].`)
  return 0
}

async function cmdShow(e: Env, id: string | undefined, json: boolean): Promise<number> {
  if (!id) {
    console.error('usage: session-deck show <session-id>')
    return 2
  }
  const reviews = await openReviews(e)
  const r = reviews.get(id)
  if (!r) {
    console.log(`No cached review for ${id.slice(0, 8)}. Run: session-deck review ${id} --run`)
    return 1
  }
  if (json) console.log(JSON.stringify(r, null, 2))
  else printReview(r, false)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const cmd = args.shift()
  const e = env()
  switch (cmd) {
    case 'list':
      return cmdList(e, flag(args, '--json'))
    case 'review':
      return cmdReview(e, args)
    case 'star':
      return cmdStar(e, args[0], true)
    case 'unstar':
      return cmdStar(e, args[0], false)
    case 'show':
      return cmdShow(e, args[0], flag(args, '--json'))
    case 'board':
      return cmdBoard(e, args)
    case undefined:
    default:
      console.log(
        [
          'session-deck — favorites and reviews for Claude Code sessions (shares ~/.session-deck with the VS Code extension)',
          '',
          '  session-deck list [--json]',
          '  session-deck review [<id>|all] [--run] [--force] [--model <alias>] [--json]',
          '  session-deck show <id> [--json]',
          '  session-deck board [--kind mechanical|decision|user_action] [--all] [--json]',
          "  session-deck board --prompt <id>   the seed prompt for that session's open items",
          '  session-deck star <id> | unstar <id>',
          '',
          `  data: ${e.dataDir}   transcripts: ${e.projectsDir}   home: ${homedir()}`,
        ].join('\n')
      )
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  )
}
