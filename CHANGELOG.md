# Changelog

## Unreleased

- **Layout: the dashboard is now the height of its tab, and sections are resizable.** Header and
  stat strip stay put; Sessions, Live now and Suggested share what is left, each scrolling inside
  itself instead of the page. Live now and Suggested start **folded**, so Sessions is the whole
  page until you open one; a **drag handle** between two open sections (arrow keys work too) sets
  the split, and the split is remembered like collapse state. The Board fills the page the same
  way. The old 24 rem cap on the list — the inner scrollbar with dead space under it — is gone.
- **Search reaches the transcript** ([docs/SPEC_SEARCH.md](docs/SPEC_SEARCH.md) S2): a content
  index — user and assistant text only, one plain-text file per session in the extension's own
  storage, appended incrementally behind the session index — makes a word buried mid-conversation
  findable on both the dashboard and the sidebar. A session found only that way shows **matched in
  transcript** with a snippet. Measured on the real corpus before building: 727 MB of JSONL is
  25.6 MB of text; 41 visible sessions index in under a second; queries answer in milliseconds.
- **Search** ([docs/SPEC_SEARCH.md](docs/SPEC_SEARCH.md) S1): a search box in the dashboard header
  filters favorites, live, the Board and turns Suggested into **Matches** — every other matching
  session, so search reaches sessions no shelf lists. A magnifier on the sidebar view filters the
  tree with the same matcher (a **Clear filter** row and icon appear while it is active; groups open
  and paging is off so every match is visible). Words are ANDed against title, first and last
  prompt, preview, project, branches, PRs (`#42`) and id prefix. View state only — never persisted.
  Transcript content is not searched yet (S2).
- **Do this / Fix this / Take this direction now land in an already-open session's composer.**
  Claude Code refuses to seed a panel that is open ("Session is already open. Your prompt was not
  applied") and has no API to set its input, so Session Deck recycles the tab: close, reopen in the
  same column with the prompt. It will not do that to a session whose live record says `busy`
  (a turn is running) or when two tabs share the title — those keep the clipboard fallback. A
  draft sitting in that composer is lost by the recycle.
- Review card: every "Still to do" and "Blocked on" item has an **Ignore** button that hides it
  (and **Show N ignored** / **Unignore** to bring it back). The state is the Board's `dismissed`
  in `~/.session-deck/board.json`, so ignoring on the card dismisses on the Board and vice
  versa, and an item marked done on the Board is hidden on the card too. Items keep their
  bullets and get more breathing room; **Do this** / **Fix this** are the primary (accent)
  action, on the Board as well.
- Fixed: with the Review modal open, typing in another Claude Code session pulled the caret out of
  its composer. The dialog restored focus from an effect whose dependency list contained a handler
  that was a new function on every render, so every state push — and a push follows every keystroke
  in any indexed session — fired the restore. It now restores focus on close only, and only when
  the webview still has it.
- The Session Deck sidebar now opens the dashboard tab too (`sessionDeck.openDashboardWithSidebar`,
  on by default); the sidebar keeps the focus.
- Board: `board.json` is now actually pruned on load, as documented. `session-deck board` prints the
  same order as the dashboard (it sorted by priority alone before, with no recency tiebreak and no
  blockers-first rule), refuses an unknown `--kind` instead of returning an empty board, and refuses
  a `--prompt` prefix that matches more than one session instead of composing one prompt out of
  several sessions' items. An item that appears in both a session's to-do and blocked lists is one
  row, now tagged as the blocker. The Board's empty state tells apart "nothing starred",
  "starred but not reviewed" (with the Analyse button) and "everything closed".
- **Deck Board** ([docs/SPEC_BOARD.md](docs/SPEC_BOARD.md)): a `Favorites ⇄ Board` switch in the
  dashboard showing every outstanding to-do and blocker across every starred session, each
  classified `mechanical` / `decision` / `user_action` by the review that already runs (no extra
  model call). Filter by kind, mark done or dismissed (state persists in `~/.session-deck/board.json`
  and survives a re-analysis that did not reword the item), and multi-select across sessions to seed
  them back — grouped per session, one click each, seeded never sent. `session-deck board` prints
  the same queue in the terminal.
- Reviews now carry `items[]` alongside `next_steps`/`blockers`; the strings stay canonical, so an
  item the model fails to classify degrades to "needs triage" rather than being mis-tagged. Reports
  written before this count as out of date, so one Analyse brings them current.
- Review: a **completion score** (0–100 with a one-line reason) per session, shown as a meter on
  the card, averaged in the modal header, and as a clickable badge on each favorite card; reports
  written before the score count as out of date so one Analyse brings them up to date.
- Review: every "Still to do" and "Blocked on" item has its own **Do this** / **Fix this** action
  that opens the session with a prompt for just that item (seeded, never sent).
- Open: a prompt is now **always copied to the clipboard**. When the session's panel is already
  open, Claude Code drops the prompt ("Session is already open…"); Session Deck now recognises that
  tab by title, reveals it without the prompt (so Claude Code stays quiet), focuses the composer and
  says to paste.
- P6: the `/session-deck` Claude Code skill — `skills/session-deck/` (SKILL.md + a CLI bundled
  from the extension's own modules): list, review [--run], show, star/unstar over the same
  `~/.session-deck` files; `pnpm skill:install` symlinks it into `~/.claude/skills`.
- P5: marketplace metadata, icon, walkthrough, README with screenshots; `.vsix` verified to
  install and activate with zero configuration on a fresh profile.
- P4: Review — headless `claude -p --json-schema` analyser (isolated: no hooks, MCP, CLAUDE.md or
  session persistence), tail-first transcript builder with compaction digest, cached reports in
  `~/.session-deck/reviews/`, batch runner with concurrency/cancel/per-session failure, and the
  full-height Review modal: pinned progress bar with inline errors, priority-ordered cards,
  unreviewed stubs, radio directions that seed (never send) a prompt; `Review Session` on any
  session from the tree.
- P3: the dashboard — favorites grouped by project (workspace first), grid/list, verbose switch,
  tip decks with a pinned how-to, per-section picker (no Save), Live and Suggested shelves,
  drag-to-reorder, missing cards; SessionOpener with panel / new-window / terminal paths and
  seeded (never sent) prompts; `Open Session with Prompt…` and `Open in New Window` in the tree.
- P2: favorites store (`~/.session-deck/favorites.json`, atomic, idempotent, fractional reorder,
  cross-window watcher), resolver registry with the `session` resolver, sidebar tree
  (Favorites by project → Live now → Recent, inline stars, context menu), `Favorite Current
  Session`, missing-session rendering; e2e suite runs against a fixture `~/.claude`.
- P1: session indexer — head+tail fast tier, resumable append-aware full pass, live-session
  detection via `~/.claude/sessions`, targeted watcher rescans, disposable cache in globalStorage;
  stat strip reads real numbers; `Session Deck: Re-index Sessions` and `Show Output` commands.
- P0: extension scaffold — dashboard webview shell (theme-token only), sidebar container,
  `Session Deck: Open Dashboard` command, typed host↔webview message contract, unit + e2e smoke
  suites, CI.
