# Changelog

## Unreleased

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
