# Changelog

## Unreleased

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
