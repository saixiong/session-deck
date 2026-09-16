---
name: session-deck
description: List, star and review your favorite Claude Code sessions from the terminal, and print the Board — everything those sessions still owe the user, classified by whether it needs a human. Use when the user says "/session-deck", asks what their starred sessions are or what is outstanding across them, wants a state-of-play review of a session, or wants to star/unstar one.
---

# Session Deck

Session Deck keeps favorites and cached reviews in `~/.session-deck/` (favorites.json, reviews/).
This skill drives the same files through a bundled CLI, so anything you do here shows up in the
VS Code extension unchanged, and vice versa.

The CLI lives next to this file: run it with `node "<this skill's directory>/cli.js" …`.

## Commands

| Intent | Command |
| --- | --- |
| List favorites (title, project, last active, cached priority + completion %) | `cli.js list` (`--json` for machine-readable) |
| Print cached reviews for all favorites | `cli.js review` |
| Analyse stale/unreviewed favorites, then print | `cli.js review --run` |
| Review one session (starred or not) | `cli.js review <session-id> --run` |
| Re-analyse even if fresh | add `--force` |
| Pick the model | add `--model haiku` (default `sonnet`) |
| One full report | `cli.js show <session-id>` |
| Star / unstar | `cli.js star <session-id>` / `cli.js unstar <session-id>` |
| The Board: every outstanding item across all starred sessions | `cli.js board` (`--json`) |
| Only one kind of work | `cli.js board --kind mechanical\|decision\|user_action\|unclassified` |
| Include items already done or dismissed | `cli.js board --all` |
| The prompt for one session's open items | `cli.js board --prompt <session-id>` |

Session ids are the UUIDs of files under `~/.claude/projects/<slug>/`; `list --json` prints them.

## The Board and what its tags mean

`board` flattens every "still to do" and "blocked on" from every starred session's cached review
into one queue, ordered by session priority then recency, blockers first within a session. Each
item carries a `kind`:

| Kind | Means |
| --- | --- |
| `mechanical` | One obvious way to do it; no judgment that forks the code. |
| `decision` | Needs a human choice that changes what gets built. |
| `user_action` | Only the user can do it — pushing their own commits, approving a submission. |
| `unclassified` | The model's tag did not survive reconciliation. Needs triage; treat as unknown. |

**These tags are a model's judgment, not a permission system.** They came from the same review that
wrote the summary and can be wrong, and the honest failure mode is that something needing a decision
is tagged `mechanical`. So:

- Never do a `decision` or `user_action` item on the user's behalf, and never treat `mechanical` as
  a licence to act unasked — the Board is for showing and handing over, not for acting (B8).
- `board` only reads. The one thing that changes state is the extension's own Done/Dismiss/Seed;
  the CLI has no write for them by design.
- An item stays listed until a *new* review no longer mentions it, or the user marks it done. Its
  presence is not evidence that it is still true.

## How to use it

1. Run the command the user asked for. `list` and `show` are free. `review --run` spends one model
   call per stale session on the user's own `claude` login (headless, no hooks, no session
   persistence); say so before running it on many sessions, and report the cost the CLI prints.
2. Present the output plainly: for reviews, the summary, done / still to do / blocked on, the
   priority and why, the completion score (0–100 against the session's own goal), and the recommended directions with their prompts. Most urgent first.
3. When the user picks a direction, hand them the prompt to paste into that session (or resume it:
   `claude --resume <session-id>` from the session's project folder) — never send it for them.
4. For `board`, group by session as the output does and lead with the blockers. Say how many items
   need a decision from them, because that is the number they cannot delegate. If they want to act
   on a session's items, `board --prompt <session-id>` composes the prompt to hand over.

## Environment

- `SESSION_DECK_DATA_DIR` (default `~/.session-deck`), `SESSION_DECK_PROJECTS_DIR`
  (default `~/.claude/projects`), `SESSION_DECK_CLAUDE` (path to the claude CLI; auto-detected
  otherwise), `SESSION_DECK_MODEL`.
- The CLI never writes under `~/.claude`.
