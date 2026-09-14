# Changelog

## Unreleased

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
