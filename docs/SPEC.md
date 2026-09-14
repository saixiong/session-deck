# SPEC — Session Deck: a favorites dashboard for Claude Code sessions (VS Code extension)

**Status:** Draft, 2026-09-14. Decisions D1–D10 and Q1–Q4 answered with Sai this session; nothing built.
**Basis:** `SPEC_DASHBOARD_FAVORITES.md` (in the snippbot repo, `docs/specs/`) (the Snippbot daemon Dashboard — stars, picker, grid/list, tip decks, Suggested shelf) and `SPEC_CHAT_REVIEW.md` (snippbot repo, `docs/specs/`) (the "Review chats" analysis modal), plus the changes made in the *Snippbot daemon dashboard specs audit* session (`70e8910b`) after those docs were written — see §2.1.
**Surface:** a **standalone VS Code extension** (its own repo, working name **Session Deck**), not a Snippbot package. This spec lives here only because the design is derived from Snippbot's; it moves with the code when the repo exists.
**Not:** a Claude Code skill or plugin (D1), a replacement for the Claude Code extension's own session list, or anything that writes into `~/.claude/`.

---

## 1. What this is

The Snippbot Dashboard answers "what am I working on?" for *daemon* entities. Session Deck answers the same question for **Claude Code sessions in VS Code**:

1. A **stat strip** — live sessions right now, sessions active in the period, output tokens, PRs linked, favorites count, index freshness.
2. **Favorites** — every session the user has starred, grouped by project, as cards with a title, subtitle, preview of the last reply, live/missing status, and a deep link that opens the session in the Claude Code panel.
3. **Review** — one button that analyses each starred session and produces a *state-of-play report*: summary, done, still to do, blocked on, priority 1–5, and 2–4 recommended directions rendered as a radio group. Choosing a direction opens that session with the chosen prompt **seeded into the composer, never sent**.
4. A **Suggested** shelf of recently active, not-yet-starred sessions, and a **Live now** strip.

The extension owns the whole experience: a sidebar tree for quick starring, a webview dashboard, command-palette entries, and a headless `claude -p` analyser that runs on the user's existing login.

**Non-goals (v1):** editing or deleting Claude sessions; favoriting sub-entities (a single turn, a subagent); multi-machine sync; anything that mutates `~/.claude/` (D5); showing sessions from `sdk-cli` producers by default (D8).

---

## 2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **VS Code extension**, not a Claude Code skill/plugin | Decided 2026-09-14. A skill has no persistent UI: every "dashboard" is a text dump, a star has no click target, and it cannot open a session for you. The extension can call the Claude Code extension's own open-session command (§3.4). A thin `/session-deck` skill that reads the same files ships last, as P6 (Q4). |
| D2 | **Analysis runs through headless `claude -p`**, not the Anthropic API | Decided 2026-09-14. Uses the user's existing login and the models they already pay for; no key to store; `--json-schema` gives structured output; `--no-session-persistence` keeps analysis runs out of the session list. Mirrors Chat Review D1 ("reuse the model the user already configured"). |
| D3 | **Standalone repo**, standalone Marketplace listing | Decided 2026-09-14. Not a Snippbot surface; ships on its own cadence; dodges the monorepo's react-19 hoist problem that breaks fresh-worktree UI tests (`reference_ui_tests_react19_hoist`). |
| D4 | **All projects, grouped, current workspace first**; `sdk-cli` sessions hidden behind a filter | Decided 2026-09-14. A favorite in another repo is still one click away. On this machine 853 of 892 session files are Snippbot's claude-native prompt logs (`entrypoint: "sdk-cli"`) — listing them would bury the 38 real VS Code sessions. |
| D5 | **Never write into `~/.claude/`.** Favorites, reviews and the index live in the extension's own store (§4) | `~/.claude` is Claude Code's; its layout is undocumented and changes per release. Reading is unavoidable; writing would be a fight with the owner. |
| D6 | **One generic favorites store with an `entity_type`**, even though v1 ships one type (`session`) | Same shape as Snippbot D1. `project` (a `~/.claude/projects/*` slug) and `pr` (from `pr-link` records) are the obvious next kinds; a per-kind store would mean a migration each. |
| D7 | **Reviews use the exact `ChatReview` shape from Snippbot** (`summary, done[], next_steps[], blockers[], priority, priority_reason, options[]`) | The two tools then produce interchangeable reports, and the modal design is already proven. Session-specific facts (PRs, tokens, branch) come from the index, not the model — the model is never asked for what the file already says. |
| D8 | **Index is incremental and append-aware; no full-file parse on load** | 892 files, 619 MB, one file is 341 MB. JSONL sessions are append-only, so a parse can resume from the last byte offset; a fresh full pass happens once per file, in the background, largest last. |
| D9 | **Seed, don't send** (Chat Review D7) | The Claude Code webview's `initialPrompt` is applied with `setInputText()` — it lands in the composer and waits. The extension relies on that; it never uses the auto-submitting `claude --resume <id> "<prompt>"` form. |
| D10 | Every Snippbot dashboard behaviour that survived four rounds of use is kept as-is: **always-render sections with tip decks (D9), quarantined Suggested shelf (D10), per-section picker (D12), grid/list (D13), verbose switch (D16), star-visible-when-set/hover-otherwise (§16.1), `missing` rendering (D6), no Save button in the picker** | Those were user-reported gaps fixed in production; re-deriving them would re-find the same bugs. §13 traces each. |

---

## 3. Ground truth — verified 2026-09-14 on this machine

### 3.1 Where sessions live

```
~/.claude/
  projects/<slug>/<sessionId>.jsonl     the transcript (append-only JSONL)
  projects/<slug>/<sessionId>/          side dir: tool-results/, subagents/, occasional *.txt
  sessions/<pid>.json                   one per RUNNING claude process (live-session signal)
  history.jsonl                         CLI prompt history only (66 lines) — NOT a session index
  stats-cache.json                      daily message/session/tool counts, last computed 2026-02-27 — stale, ignore
```

`<slug>` is the working directory with `/` replaced by `-` (`/Users/saixiong/projects/snippbot` → `-Users-saixiong-projects-snippbot`). Worktrees are separate slugs. 69 slugs here; 892 `.jsonl` files; 619 MB total; largest 341 MB.

**Nothing under `~/.claude` is a documented contract.** Every reader in §5 must treat an unknown record type as "skip", never as an error (the same lesson as Snippbot A17-1).

### 3.2 Record types in a session file

Per-line `type` values seen, with the fields the index uses:

| `type` | Fields used | Notes |
|---|---|---|
| `user` / `assistant` | `uuid, parentUuid, timestamp, sessionId, cwd, gitBranch, entrypoint, version, isSidechain, isMeta, message.{role,content,model,usage}` | `entrypoint` ∈ `claude-vscode`, `sdk-cli` (Snippbot's claude-native), CLI sessions presumably `cli`. `usage` carries `input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens`. `content` is a string or a list of `{type: text\|thinking\|tool_use\|tool_result}` blocks. |
| `ai-title` | `aiTitle, sessionId` | Auto-generated title. **Repeated** as the title is regenerated; the **last one wins**. This is how "Snippbot daemon dashboard specs audit" is stored. |
| `last-prompt` | `lastPrompt, leafUuid` | Cheap "what was I last asked". |
| `pr-link` | `prNumber, prUrl, prRepository, timestamp` | PRs opened from the session. |
| `summary` | `summary, leafUuid` | Short compaction summary — a free pre-digest for the analyser. |
| `system` (`subtype: compact_boundary`) | `compactMetadata.{trigger, preTokens, durationMs}` | Compaction count + size. The user message immediately after it is the long "This session is being continued…" digest. |
| `mode`, `queue-operation`, `atis-latch`, `bridge-session`, `attachment`, `file-history-snapshot`, `total_tokens_reminder`, `todo_reminder` | — | Skipped. |

A session renamed via **Rename Session Tab** / `/rename` stores its custom title somewhere not yet observed (no renamed sessions exist on this machine). **P1 task:** rename one, diff the file, honour that record above `ai-title`.

### 3.3 Live-session signal

`~/.claude/sessions/<pid>.json`:

```json
{"pid":11080,"sessionId":"52224c3e-…","cwd":"/Users/saixiong/projects/snippbot","startedAt":1789401623667,
 "version":"2.1.270","kind":"interactive","entrypoint":"claude-vscode","name":"snippbot-56","updatedAt":1789402036573,…}
```

A session is **live** when a file names it *and* `process.kill(pid, 0)` succeeds. Stale files after a crash are the norm, so the pid check is mandatory.

### 3.4 What the Claude Code VS Code extension exposes (v2.1.270, read from its bundle)

- **Command** `claude-vscode.editor.open(sessionId, initialPrompt, …)` — opens (or focuses) that session in the Claude panel, honouring the user's preferred location; `initialPrompt` is placed in the composer via `setInputText()` and **not sent**. Also `claude-vscode.primaryEditor.open(sessionId, prompt)`, `claude-vscode.window.open`, `claude-vscode.toggleFocusView`, `claude-vscode.terminal.open`.
- **URI handler** `vscode://anthropic.claude-code/open?session=<id>&prompt=<text>` → `primaryEditor.open`. Works from another window via `vscode.env.openExternal`.
- The extension bundles its own CLI (`claude --version` on PATH is 2.1.201; the extension is 2.1.270). Session ids are validated (`cq(id)`) before use.

**None of this is a published API.** It is the best available hook and must be wrapped behind one `SessionOpener` with a terminal fallback (§7.4) and a version check that degrades to the fallback rather than failing.

### 3.5 Headless CLI surface for the analyser

`claude -p --bare --no-session-persistence --output-format json --json-schema <schema> --model <alias> --tools "" --system-prompt <text>` reads the user prompt from stdin/argv and returns one JSON object. `--bare` skips hooks, LSP and plugins — required, or the user's own hooks fire inside every review. `--no-session-persistence` is required or every review shows up in the Dashboard as a new session. Result shape (`result`, `structured_output`, `total_cost_usd`, `usage`) is **recorded, not assumed** — P4's first task is one real call captured into a fixture.

---

## 4. Data model

All under `${dataDir}` (default `~/.session-deck/`, setting `sessionDeck.dataDir`). Plain JSON, human-readable, one file per concern. The **index cache** is disposable and lives in `context.globalStorageUri` instead — deleting it costs a re-index, never data.

### 4.1 `favorites.json`

```jsonc
{
  "version": 1,
  "favorites": [
    {
      "id": "fav_3f9c1a2b7d4e",          // stable handle for reorder/remove
      "entity_type": "session",          // D6 — registry key
      "entity_id": "70e8910b-9d55-…",    // session uuid (globally unique; slug is derivable)
      "label": "Snippbot daemon dashboard specs audit",   // title snapshot — what a `missing` card shows
      "note": null,
      "sort_order": 1024,                // REAL; insert-between = (prev+next)/2
      "created_at": "2026-09-14T16:20:11Z",
      "updated_at": "2026-09-14T16:20:11Z"
    }
  ]
}
```

Uniqueness on `(entity_type, entity_id)` is enforced in code (add is idempotent; a second add returns the existing row). Writes are atomic (`write tmp → rename`). A file watcher on `favorites.json` keeps a second VS Code window coherent — the file *is* the event bus.

### 4.2 `reviews/<sessionId>.json`

The `ChatReview` shape (D7) plus what only this tool knows:

```jsonc
{
  "conversation_id": "70e8910b-…", "title": "…",
  "summary": "…", "done": [], "next_steps": [], "blockers": [],
  "priority": 4, "priority_label": "High", "priority_reason": "…",
  "options": [{"id": "ship-progress-bar", "label": "…", "description": "…", "prompt": "…"}],
  "model": "claude-sonnet-5", "analyzed_at": "…",
  "fingerprint": "1412:2026-09-14T16:11:50.949Z",     // messageCount:lastMessageAt  (Chat Review D3)
  "message_count": 1412,
  "cost_usd": 0.0412, "duration_ms": 18400,            // from the claude -p result
  "error": null
}
```

Failures are **never persisted** (Chat Review D4); a review carrying `error` exists only in the modal's in-memory batch state. A file whose JSON no longer parses is a cache miss.

### 4.3 Index cache — `globalStorage/index.json` + per-session offsets

```jsonc
{ "version": 1, "sessions": { "<sessionId>": SessionIndexEntry, … } }
```

`SessionIndexEntry` (the load-bearing structure; everything the card and the stat strip show comes from here, never from a parse at render time):

```ts
interface SessionIndexEntry {
  sessionId: string; slug: string; filePath: string
  cwd: string; gitBranches: string[]; entrypoint: string; version: string
  title: string | null            // last ai-title (or custom title, §3.2)
  firstPrompt: string             // first non-meta user text, clipped
  lastPrompt: string | null       // last-prompt record
  preview: string | null          // tail of the last assistant text block, markdown-stripped, ≤280 chars
  createdAt: string; lastActiveAt: string
  messageCount: number; userTurns: number; toolUses: number; compactions: number
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number }
  models: string[]; prLinks: { number: number; url: string; repo: string }[]
  // bookkeeping
  size: number; mtimeMs: number; parsedTo: number   // byte offset the full pass reached
  fast: boolean                                     // true = head+tail only, full pass pending
  missing: boolean
}
```

---

## 5. The session indexer (D8)

Two tiers, both incremental:

**Fast tier — head + tail, synchronous-ish, on every refresh.** For each `.jsonl` whose `(size, mtimeMs)` changed: read the first 64 KB for `cwd/gitBranch/entrypoint/version/createdAt/firstPrompt` and the last 256 KB (read backwards) for `lastActiveAt`, `lastPrompt`, `preview`, and the latest `ai-title` — Claude Code re-emits the title record roughly every 20 lines (verified: 300 occurrences in an 8,664-line file), so the tail read almost always has one; the full tier is the guarantee. Enough to render a card. ~900 files × 2 small reads is sub-second.

**Full tier — streaming pass, background, resumable.** A worker walks the file line-by-line from `parsedTo` to EOF, accumulating counts, tokens, models, PR links, compactions and the last `ai-title`. On finish, `parsedTo = size`. Because the file is append-only, the next pass is O(bytes appended). If `size < parsedTo` (file replaced/truncated), restart from 0. Queue order: changed files first, then never-indexed smallest-first, so 341 MB is the *last* thing the machine does, not the first. Concurrency 2; yields between files; cancelled on deactivate.

**Detection:** `fs.watch` on `~/.claude/projects` (recursive works on macOS/Windows; Linux falls back to a 30 s stat poll of known files + a 5 min directory rescan) with a 500 ms debounce → fast-tier the changed file → `postMessage` to open webviews. Live status re-checked on a 10 s timer while a dashboard is visible, else on demand (zero idle polling — `project_loops_idle_polling`).

**Parsing rules:** unknown `type` → skip. Malformed line → skip and count (`parseErrors`, shown in the stat strip tooltip, never a failure). `isMeta` and `isSidechain` records are excluded from `messageCount` and from the preview. `entrypoint` is read from the first `user`/`assistant` record.

**Title resolution:** custom title (§3.2, once discovered) → last `ai-title` → `firstPrompt` clipped to 80 chars → `"Untitled session"`.

---

## 6. The entity registry (D6)

```ts
interface FavoriteResolver {
  entityType: 'session' | 'project' | 'pr'
  label: string; icon: string                        // section heading + codicon
  hydrate(ids: string[]): Map<string, FavoriteCard>  // missing ids absent → caller marks `missing`
  browse(query: string | null, limit: number): FavoriteCard[]   // picker source
  suggest(limit: number, exclude: Set<string>): FavoriteCard[]  // Suggested shelf
}
interface FavoriteCard {
  entityId: string; title: string; subtitle: string | null; preview: string | null
  details: { label: string; value: string; kind?: 'datetime' | 'text' | 'link' }[]
  status: 'live' | 'missing' | null; statusVariant: 'success' | 'warning' | 'error' | 'info' | null
  updatedAt: string | null; meta: Record<string, unknown>
}
```

Only `session` ships in v1. It is entirely index-backed, so `hydrate`/`browse`/`suggest` are in-memory map lookups — the N+1 risk that dominated the Snippbot spec (R1) does not exist here, and the picker's `browse()` may filter all ~900 entries on every keystroke.

**`session` card:** title (§5) · subtitle `"<project basename> · <branch> · <relative lastActiveAt>"` · preview = index `preview` · details = Turns, Tool calls, Output tokens, PRs (links), Model, Compactions, Started · status `live` (green) when §3.3 says so, `missing` when the file is gone.

**Deferred (v1.1):** `project` (star a slug to pin its group to the top), `pr` (a `pr-link` → GitHub URL + the session that opened it).

---

## 7. Extension architecture

```
session-deck/
  package.json                 contributes: views, commands, keybindings, configuration, walkthrough
  src/extension.ts             activate(): wire stores, indexer, tree, dashboard, commands
  src/index/                   SessionIndexer, jsonlTail.ts, jsonlStream.ts, liveSessions.ts
  src/store/                   FavoritesStore, ReviewStore (atomic JSON files + watchers)
  src/registry/                resolvers.ts (session), cards.ts
  src/analyze/                 ClaudeCli (spawn/kill/timeouts), transcript.ts, schema.ts, ReviewRunner
  src/open/                    SessionOpener (command → URI → terminal fallback)
  src/views/tree/              SessionTreeProvider (sidebar)
  src/views/dashboard/         DashboardPanel (WebviewPanel host, message bridge)
  webview/                     Preact + esbuild; VS Code theme vars only; no network
  test/fixtures/sessions/      hand-written JSONL incl. every record type in §3.2 + a generated 100 MB file
```

- **Runtime:** Node (extension host) does all file IO and process spawning. The webview is pure UI and talks over `postMessage` with a typed message union.
- **UI stack:** Preact (3 KB, no hoist fights), esbuild, `@vscode/codicons`. **Theme:** only `--vscode-*` CSS variables (`--vscode-editor-background`, `--vscode-badge-background`, `--vscode-focusBorder`, …) and `body.vscode-dark|light|high-contrast` — the "make sure design uses theme" requirement from the audit session, in VS Code terms.
- **Sidebar tree ("Session Deck")** — the cheap "star where the user already is" surface: `Favorites` (grouped by project) → `Live now` → `Recent` (per project, newest first, 20 per project then "Show more"). Each row: title, relative time, inline star (`$(star-full)` when set, `$(star-empty)` on hover — the §16.1 rule), context menu: Open / Open with prompt… / Review (works on **any** session, starred or not — Q2; the report is cached the same way and shown in a single-session view) / Copy session id / Reveal file.
- **Commands:** `sessionDeck.openDashboard`, `sessionDeck.favoriteCurrentSession` (resolve via §3.3: live sessions whose `cwd` is in the workspace, most recently updated; quick-pick if several), `sessionDeck.toggleFavorite` (tree/dashboard), `sessionDeck.reviewFavorites`, `sessionDeck.reviewSession`, `sessionDeck.reindex`, `sessionDeck.openSession`. Default keybinding only for `openDashboard` (`ctrl/cmd+shift+alt+d`); the rest are palette-only until someone asks.

### 7.4 `SessionOpener` — opening a session, in order of preference

1. `commands.executeCommand('claude-vscode.editor.open', sessionId, prompt)` when the Claude Code extension is active and its version is in the tested range.
2. `env.openExternal('vscode://anthropic.claude-code/open?session=…&prompt=…')` — used for **Open in new window** (`openFolder` in a new window first when the session's `cwd` is not in the current workspace, then the URI).
3. **Terminal fallback** (setting `sessionDeck.openTarget: "terminal"` or when 1–2 are unavailable): `createTerminal({cwd})` → `sendText('claude --resume <id>', true)` → after the process is up, `sendText(prompt, false)` so the prompt is typed but not executed. Opt-in because the delay is a heuristic.

Then, if `sessionDeck.openInFocusView` is on, `claude-vscode.toggleFocusView` — the analog of Snippbot's "open in focus mode".

**P3 must verify** cross-project opening (a favorite whose `cwd` ≠ workspace) through path 1; if the Claude extension only resolves sessions of the current workspace, path 2 with `openFolder` is the default for those cards.

---

## 8. Dashboard UI (webview)

### 8.1 Anatomy

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Session Deck                          [24h ▾]  [grid|list]  [verbose ●]  │
├──────────────────────────────────────────────────────────────────────────┤
│ Live 2 │ Active 14 │ Output tokens 3.1M │ PRs 6 │ Favorites 7 │ Index ✓ │  ← §8.2
├──────────────────────────────────────────────────────────────────────────┤
│ ★ FAVORITES (7)          [ Review sessions ]  [+ Add]   [💡]  collapse ▾ │  ← Review = accent button
│   snippbot (5)                                                           │
│   ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐  │
│   │ ● Snippbot daemon… │ │ In-flight turn gu… │ │ Mobile LAN routin… │  │
│   │ snippbot · main · 2m│ │ snippbot · 1d      │ │ snippbot · 1d     │  │
│   │ "Fixed and live…"  │ │ "…on-device confi…"│ │ "OTA republished…"│  │
│   └────────────────────┘ └────────────────────┘ └────────────────────┘  │
│   other-repo (2) …                                                       │
│   (empty) → tip deck expanded: "Star a session from the Session Deck     │
│             sidebar or ⌘⇧P → Favorite current session"   ‹ 2/5 ›        │
├──────────────────────────────────────────────────────────────────────────┤
│ LIVE NOW (2)  ● snippbot-56 · 41m   ● snippbot-12 · 3h        [★ each]  │
├──────────────────────────────────────────────────────────────────────────┤
│ SUGGESTED — recently active, not yet starred                    [★ each] │
└──────────────────────────────────────────────────────────────────────────┘
```

- The Favorites section **always renders** (Snippbot D9); empty → tip deck expanded with `howToAdd` pinned under a divider; populated → deck collapsed behind the lightbulb. Random start index chosen once per mount; arrows wrap; `aria-live="polite"`; ≥5 tips (starring, the sidebar, `/resume` vs Session Deck, what Review costs, hiding `sdk-cli`, cross-project opening).
- Inside the section, cards are **grouped by project**, current workspace's group first, then by `sort_order`. Drag-to-reorder within a project group writes `sort_order` (fractional insert).
- **Grid / list** toggle and **verbose** switch, both persisted in `globalState` (`sessionDeck.view`, `sessionDeck.verbose`). List rows scroll inside the section (`max-height`), so 40 starred sessions cannot push Live/Suggested off screen.
- **Missing** card (file gone, or slug removed): dimmed, label snapshot, "No longer on disk", Remove. Never silently dropped.
- **Add** opens the picker (§8.3). **Review sessions** opens the modal (§9) and is styled with `--vscode-button-background` at full weight — the audit session's "I need that button to really stand out" applies here from day one.
- `sdk-cli` sessions are excluded everywhere unless `sessionDeck.showSdkSessions` is on (D4); the filter state is shown in the stat strip tooltip so a "missing" session is explainable.

### 8.2 Stat strip

All from the index; zero model calls. Period selector `24h | 7d | 30d`, default `24h`, persisted. Tiles: **Live** (§3.3), **Active** sessions with `lastActiveAt` in period, **Output tokens** in period (sum of `usage.output_tokens` of assistant records in period — needs the full tier; shows "≈" while any file is still `fast`), **PRs** (`pr-link` in period), **Favorites**, **Index** (✓ / "indexing 12 of 892" / parse-error count). One shared `StatTile` component for the strip and the Review modal's cost tile.

### 8.3 Picker (Snippbot D12/§9.7)

One modal, backed by `browse()`. Rows: title · subtitle · 2-line preview · tick. Search matches title + first prompt + project (not transcript content — Chat Review §17.2's decision, same reason). Ticking stars immediately; **no Save**. Filters: project, entrypoint, "has PR", "live". Shows "N of M sessions" so truncation is never silent (A17-4).

### 8.4 Suggested + Live

Suggested = `suggest(12, favoritedIds)` ordered by `lastActiveAt`, type chip, quieter surface, star as primary action, hides itself when empty. Live = sessions from §3.3 not already starred, with the process name and uptime; a live session that is also starred shows the ● on its Favorites card instead of appearing twice.

---

## 9. Review modal — the analysis and recommendations

Mirrors `SPEC_CHAT_REVIEW.md` (snippbot repo, `docs/specs/`) plus what #850/#852 and the 2026-09-14 request added.

### 9.1 Layout

Full-height modal with a small margin (in-webview overlay; the panel is already full-bleed). **Pinned header:** status strip ("7 starred · 3 reviewed · 2 out of date · 2 unreviewed"), **Analyse N** button (only stale + unreviewed), **Re-analyse all**, cost note ("one model call per session; last batch $0.31"), and — while a batch runs — a **progress bar**: `3 of 7` with per-session state (queued / running / done / failed) and a Cancel that kills the child processes. **Scroll region** (`flex:1; min-height:0; overflow-y:auto` — the exact shape #852 pinned with tests) holds the cards.

### 9.2 Cards

Ordered by priority desc, then `lastActiveAt` desc. **Every starred session appears** (#850): unreviewed ones render a stub card (title, subtitle, preview) with a message and a large **Review this session** button; failed ones render the stub plus the error **inline**, with Retry. A reviewed card shows: summary · Done · Still to do · Blocked on · priority badge + reason · stale badge when the fingerprint moved · footer: model, analyzed_at, cost · **directions as a radio group** with one **Take this direction** button per card → `SessionOpener.open(sessionId, option.prompt)` (D9, seed only) · **Open** (no prompt) · **Remove from favorites** · **Re-analyse**.

Directions are alternatives, hence radio not checkboxes (Chat Review D7). Submitting never closes the modal (Chat Review D8 — the user is triaging several).

### 9.3 The analyser

`ReviewRunner.analyze(ids, {force})`:

1. Dedupe ids, cap at 50, skip cached-and-fresh unless `force` (fingerprint `messageCount:lastActiveAt`, both from the index — Chat Review D3).
2. Build the transcript per session (§9.4). An empty session → a canned "nothing here yet" review with no model call (Chat Review D10).
3. Spawn `claude -p` (§3.5) with concurrency `sessionDeck.concurrency` (default 4), timeout 180 s, `cwd` = the extension's storage dir (so no CLAUDE.md or project settings leak in even if `--bare` changes meaning later), env stripped of `CLAUDE_*` overrides. The `claude` binary: `sessionDeck.claudePath` → `which claude` → `~/.local/bin/claude` → error card "Claude CLI not found" with a link to the setting.
4. Parse: prefer `structured_output`; fall back to fence-stripping + outermost `{…}` on `result` (Chat Review D6). Clamp priority to 1–5; drop options without a prompt or label; require ≥1 option or mark the review failed.
5. Per-session failure → error in batch state only, never persisted (D4/D5); success → `reviews/<id>.json`; emit progress after every state change so the bar moves per session, not per batch.

### 9.4 Transcript building

Reads the JSONL **tail-first** (Chat Review D9) via the streaming reader, keeping the last `sessionDeck.transcriptTurns` (80) `user`/`assistant` records that are not `isMeta`/`isSidechain`. Rendering: user text verbatim minus `<system-reminder>` blocks and command-output wrappers; assistant `text` blocks verbatim; `thinking` dropped; `tool_use` → `[tool: Name — <first 120 chars of input>]`; `tool_result` → `[result: N chars]` (plus the first 200 chars when it contains "error"/"Traceback"/"FAIL"). The most recent **compaction digest** (the user message after the last `compact_boundary`) is included in full at the top because it is already a curated summary of everything before it. Header block: title, project, branch(es), PR links, live?, turns, last active, total output tokens. Cap 48 000 chars, dropping from the front.

System prompt = Chat Review's `_SYSTEM_PROMPT` verbatim (it is already tuned for "where does this stand, what first"), with two added rules: the header is authoritative for facts like PRs and branch; a `[tool: …]` line means the agent ran it, not that it succeeded unless a result says so.

Cost expectation with `sonnet` as default: ~15–50k input tokens per session (mostly the transcript), ~1k output → a few cents each; the modal shows the real `total_cost_usd` after the first batch so the user calibrates from data, not from this estimate.

---

## 10. Settings (`sessionDeck.*`)

| Key | Default | Purpose |
|---|---|---|
| `dataDir` | `~/.session-deck` | favorites + reviews |
| `claudeProjectsDir` | `~/.claude/projects` | read-only source; override for `CLAUDE_CONFIG_DIR` users |
| `claudePath` | auto | CLI binary for analysis |
| `model` | `sonnet` | `--model` alias for reviews |
| `concurrency` | 4 | parallel reviews |
| `transcriptTurns` | 80 | tail turns per review |
| `showSdkSessions` | false | D4 filter |
| `openTarget` | `panel` | `panel` \| `window` \| `terminal` |
| `openInFocusView` | false | toggle focus view after opening |
| `indexLargeFilesMB` | 512 | skip full tier above this; card stays `fast` with an "≈" badge |

---

## 11. Phased plan (each phase shippable and reviewable)

**P0 — Scaffold.** Repo, `esbuild` for host + webview, Preact, `vsce` packaging, `vitest` for host code + `@vscode/test-electron` smoke, CI (tsc, eslint, tests), theme-variable CSS reset, typed `postMessage` union. *Acceptance:* `F5` opens an empty dashboard that reads correctly in light, dark and high-contrast.

**P1 — Indexer.** Fast + full tiers, resumable offsets, live-session reader, watcher, fixtures for every record type in §3.2 plus a generated 100 MB file. *Acceptance:* cold index of this machine's 892 files renders cards in < 2 s (fast tier) and finishes the full tier in the background without blocking the UI; a second activation re-parses **zero bytes** of unchanged files (assert on bytes read); appending 10 lines to the 341 MB fixture re-parses only those lines; a malformed line is counted, not fatal; the renamed-session title record is discovered and honoured.

**P2 — Favorites + sidebar.** `FavoritesStore` (idempotent add, remove by id/entity, reorder, watcher), registry with `session` resolver, tree view with inline stars, `favoriteCurrentSession`, `missing` detection. *Acceptance:* star survives reload and appears in a second VS Code window within 1 s; starring twice is a no-op; deleting the JSONL turns the row `missing`; `favoriteCurrentSession` picks the right live session with two running.

**P3 — Dashboard.** Stat strip, Favorites section (project groups, grid/list, verbose, tip deck, drag reorder, missing cards), picker, Suggested, Live, `SessionOpener` with all three paths. *Acceptance:* empty state shows the deck; opening a card lands on the right session in the Claude panel with the composer **empty**; "open with prompt" lands with the prompt **in the composer and not sent**; cross-project open verified or documented as path-2; tip index chosen once per mount (test: re-render does not reshuffle).

**P4 — Review.** `ClaudeCli`, transcript builder, schema, `ReviewStore`, modal with progress bar, inline errors, unreviewed stubs, directions → seeded open, remove, cost tile. *Acceptance:* first task is a recorded real `claude -p` call as a fixture; a batch of 5 shows per-session progress and a mid-batch Cancel leaves no child process; a failed session is listed with its error and the other four complete; a cached review is reused until the session grows; reviews never appear in the session list (`--no-session-persistence` verified by counting files before/after).

**P5 — Polish + publish.** Walkthrough, README with screenshots, keybinding, Marketplace listing, telemetry-free statement, CHANGELOG. *Acceptance:* `vsce package` clean; install from `.vsix` on a fresh profile works with zero config.

**P6 — `/session-deck` skill (Q4).** A Claude Code skill in the same repo (`skills/session-deck/SKILL.md` + a small Node script) that works on `favorites.json` and `reviews/` from the terminal: `/session-deck` lists favorites with title, project, last active and cached priority; `/session-deck review [id|all]` prints cached reports and, when asked, runs the same `claude -p` analysis (§9.3) for stale ones and writes `reviews/<id>.json` in the extension's format; `/session-deck star <id>` / `unstar <id>` edit `favorites.json` atomically. The skill and the extension cannot diverge on shape because the script imports the extension's `store/` and `analyze/` modules. *Acceptance:* a review written by the skill renders in the modal unchanged and vice versa; the skill with no `~/.session-deck/` prints how to install the extension rather than erroring; no `~/.claude/` writes.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The Claude Code extension's commands/URI are unpublished** and may change or validate args differently in a later release. | Single `SessionOpener` seam; tested-version range in `package.json`; automatic degrade to the terminal path with a one-line notice. This is the highest-blast-radius dependency. |
| R2 | **`~/.claude` layout is unpublished.** A record type is renamed and titles vanish. | Skip-unknown parsing; title fallback chain; fixtures pinned to today's shapes; index `version` bump forces a re-parse. |
| R3 | **Big files.** One 341 MB session; a naive parser freezes the extension host. | D8: head/tail first, resumable streaming pass in a worker, largest last, `indexLargeFilesMB` escape hatch. P1 asserts bytes read. |
| R4 | **`claude -p` output shape / flags drift** (`--json-schema` is new-ish). | Fixture from a real call; parser tolerant of `result` vs `structured_output`; a schema-validation failure is a per-session error, never a crash. |
| R5 | **Reviews cost real money.** | Opening is free (Chat Review D2); only stale/unreviewed are analysed; real `total_cost_usd` shown; `model` setting defaults to `sonnet`, `haiku` one click away. |
| R6 | **Hooks and CLAUDE.md leaking into reviews** (a user's `Stop` hook fires 7 times). | `--bare`, neutral `cwd`, scrubbed env. Documented in the modal's cost note. |
| R7 | **Naming/trademark.** A Marketplace listing called "Claude …" implies an official extension. | Product name **Session Deck**; description says "for Claude Code"; no Anthropic marks in the icon. |
| R8 | **Two meanings of "pin"/"favorite".** The Claude extension has its own tab groups and unread marks. | "Star"/"favorite" only in this extension's UI; never "pin". |
| R9 | **Zombie `sessions/<pid>.json` files** after crashes make everything look live. | pid liveness check (§3.3); a live tile that disagrees with the check is never shown. |
| R10 | **Sidechain/subagent records inflate counts** and skew previews. | `isSidechain` excluded from counts and preview; subagent transcripts in `<sessionId>/subagents/` are not indexed in v1. |

---

## 13. Traceability — Snippbot decision → Session Deck

| Snippbot | Session Deck |
|---|---|
| Dashboard D1 generic favorites table | §4.1, D6 |
| D2 one shared store | `~/.session-deck/` (D5 keeps it out of `~/.claude`) |
| D4 stable entity id | session uuid; the slug is derived, so a moved repo keeps its favorite |
| D5 batched hydration | index-backed `hydrate()` — in-memory, no N+1 possible |
| D6 `missing` never vanishes | §8.1 missing card |
| D8 star where the user is | sidebar tree + `favoriteCurrentSession`; **limit:** no star inside Claude's own tab strip (R1) |
| D9 always-render + tip decks | §8.1 |
| D10 quarantined Suggested | §8.4 |
| D11 `/` → dashboard | n/a — the dashboard is a command/keybinding, never auto-opened |
| D12 picker, no Save | §8.3 |
| D13 grid/list, D16 verbose | §8.1 |
| D15 media/details | `details` only (sessions have no media) |
| §16.1 star visible when set, hover otherwise | tree rows + cards |
| §16.5 414 on long ids | n/a — no HTTP |
| §7 WS events for coherence | `fs.watch` on `favorites.json` + `~/.claude/projects` |
| Chat Review D1–D10 | §9 one-for-one; D1 → `sessionDeck.model` on `claude -p` |
| #850 unreviewed cards + accent entry button | §8.1, §9.2 |
| #852 scroll region shape | §9.1 |
| 2026-09-14 progress bar + inline errors | §9.1, §9.2 |

---

## 14. Questions — answered 2026-09-14

**Q1. Should a favorite be pinned to a *project* as well (D6's `project` kind) in v1?** It would let "snippbot first" be a user choice instead of "current workspace first". → **v1.1.** The workspace-first rule covers the common case; the `project` kind stays a registry seam.

**Q2. Should Review be runnable on non-favorited sessions from the tree's context menu?** It is cheap to allow and useful for triage before starring. → **Yes.** Wired into the tree context menu (§7); the modal still lists favorites only.

**Q3. Subagent transcripts (`<sessionId>/subagents/`).** Counting their tokens would make the stat strip truthful for heavy subagent sessions. → **Skip in v1** (R10); fold into the parent entry in v1.1 once the indexer is proven on the 341 MB file.

**Q4. A thin Claude Code skill** reading `favorites.json` and `reviews/` for terminal users. → **Yes, as P6, named `/session-deck`** (§11). Lists favorites, prints cached reviews, can trigger an analysis run, and stars/unstars — sharing the extension's store and analyser code so the two can never disagree on file shape.
