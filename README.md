# Session Deck

A favorites dashboard for [Claude Code](https://claude.com/claude-code) sessions in VS Code. Star the
sessions you keep coming back to, see where each one stands, and jump back in with the next step
already typed.

![The dashboard](media/screenshot-dashboard.png)

Session Deck is an independent project and is not affiliated with Anthropic.

## What it does

- **Dashboard** — a stat strip (live sessions, activity, output tokens, PRs), your favorites grouped
  by project (this workspace first), a Live-now strip, and Suggested sessions you have not starred.
  Grid or list, a verbose switch for previews and details, drag to reorder.
- **Sidebar** — Favorites → Live now → Recent, every row with a star. `Favorite Current Session`
  stars the one running in this window.
- **Review** — one button reads each starred session's recent transcript and reports a summary,
  what is done, what is still to do, what it is blocked on, a priority (1–5), and two to four
  directions. Choosing one opens the session with that prompt **typed into the composer, never
  sent**. Reports are cached until the session moves on.

![Review](media/screenshot-review.png)

## How it works, and what it costs

- Session Deck **reads** `~/.claude/projects` (the transcripts Claude Code already keeps) and
  `~/.claude/sessions` (which sessions are running). It never writes there.
- Everything it saves — favorites, cached reviews — lives in `~/.session-deck/` as plain JSON
  (`sessionDeck.dataDir`).
- Reviews run the `claude` CLI headlessly on **your own login** (`claude -p`, structured output,
  no hooks, no MCP servers, no CLAUDE.md, no session persistence). Opening the Review modal is
  free; analysing costs one model call per session — measured at 3–7¢ per session with `haiku`
  on 80-turn transcripts, so expect roughly 10–20¢ with the default `sonnet` — and the real cost
  is shown after each batch. Nothing is sent anywhere else, and
  the extension has no telemetry.
- Sessions produced by SDK / headless runs are hidden by default (`sessionDeck.showSdkSessions`).

## Opening sessions

Claude Code resumes a session only from the folder it belongs to. A favorite from this workspace
opens in the Claude Code panel; one from another repository opens a new window on that folder.
`sessionDeck.openTarget` can force a new window or a terminal running `claude --resume`.

## Settings

| Setting                        | Default              | Purpose                                               |
| ------------------------------ | -------------------- | ----------------------------------------------------- |
| `sessionDeck.dataDir`          | `~/.session-deck`    | favorites + cached reviews                            |
| `sessionDeck.claudeProjectsDir`| `~/.claude/projects` | read-only source; override for `CLAUDE_CONFIG_DIR`    |
| `sessionDeck.claudePath`       | auto                 | `claude` CLI for reviews (bundled → PATH → ~/.local)  |
| `sessionDeck.model`            | `sonnet`             | model alias for reviews                               |
| `sessionDeck.concurrency`      | `4`                  | parallel reviews                                      |
| `sessionDeck.transcriptTurns`  | `80`                 | recent turns a review reads                           |
| `sessionDeck.showSdkSessions`  | `false`              | list `sdk-cli` sessions                               |
| `sessionDeck.openTarget`       | `panel`              | `panel` \| `window` \| `terminal`                     |
| `sessionDeck.openInFocusView`  | `false`              | toggle Claude Code's Focus view after opening         |
| `sessionDeck.indexLargeFilesMB`| `512`                | larger transcripts are indexed head+tail only         |

## Develop

```bash
pnpm install
pnpm build            # or `pnpm watch`; F5 → "Run Extension" → ⌘⇧⌥D
pnpm check            # typecheck + lint + unit tests + build
pnpm test:e2e         # smoke suite inside a real VS Code, against test/fixtures/claude
pnpm package          # builds the .vsix
```

Design notes and the phased plan are in [docs/SPEC.md](docs/SPEC.md).
