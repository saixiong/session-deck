---
name: session-deck
description: List, star and review your favorite Claude Code sessions from the terminal — the same favorites and cached reviews the Session Deck VS Code extension shows. Use when the user says "/session-deck", asks what their starred sessions are, wants a state-of-play review of a session, or wants to star/unstar one.
---

# Session Deck

Session Deck keeps favorites and cached reviews in `~/.session-deck/` (favorites.json, reviews/).
This skill drives the same files through a bundled CLI, so anything you do here shows up in the
VS Code extension unchanged, and vice versa.

The CLI lives next to this file: run it with `node "<this skill's directory>/cli.js" …`.

## Commands

| Intent | Command |
| --- | --- |
| List favorites (title, project, last active, cached priority) | `cli.js list` (`--json` for machine-readable) |
| Print cached reviews for all favorites | `cli.js review` |
| Analyse stale/unreviewed favorites, then print | `cli.js review --run` |
| Review one session (starred or not) | `cli.js review <session-id> --run` |
| Re-analyse even if fresh | add `--force` |
| Pick the model | add `--model haiku` (default `sonnet`) |
| One full report | `cli.js show <session-id>` |
| Star / unstar | `cli.js star <session-id>` / `cli.js unstar <session-id>` |

Session ids are the UUIDs of files under `~/.claude/projects/<slug>/`; `list --json` prints them.

## How to use it

1. Run the command the user asked for. `list` and `show` are free. `review --run` spends one model
   call per stale session on the user's own `claude` login (headless, no hooks, no session
   persistence); say so before running it on many sessions, and report the cost the CLI prints.
2. Present the output plainly: for reviews, the summary, done / still to do / blocked on, the
   priority and why, and the recommended directions with their prompts. Most urgent first.
3. When the user picks a direction, hand them the prompt to paste into that session (or resume it:
   `claude --resume <session-id>` from the session's project folder) — never send it for them.

## Environment

- `SESSION_DECK_DATA_DIR` (default `~/.session-deck`), `SESSION_DECK_PROJECTS_DIR`
  (default `~/.claude/projects`), `SESSION_DECK_CLAUDE` (path to the claude CLI; auto-detected
  otherwise), `SESSION_DECK_MODEL`.
- The CLI never writes under `~/.claude`.
