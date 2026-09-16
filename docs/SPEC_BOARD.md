# SPEC — Deck Board: one queue for everything your sessions still owe you

Status: **Draft**, 2026-09-16. Extends [SPEC.md](SPEC.md); every decision there (D1–D10) still
holds. Sections numbered `B*` to keep the two documents quotable side by side.

---

## B1. What this is

Session Deck already knows, per starred session, what is **still to do** and what it is **blocked
on**. Today that lives inside one card in the Review modal, one session at a time. The Board is the
same data flattened across every session into a single triage queue, with each item tagged by what
kind of work it is, so the things that need *you* are visually separated from the things that need
*someone* — and a multi-select that seeds the chosen items back into their own sessions.

**The insight this is built on:** most session turns are expensive reasoning wrapped around a
decision that had one sensible answer. The scarce thing is not execution, it is deciding which
decisions actually fork the code. The Board's job is to make that separation visible and cheap.

**What this is not, yet.** No agent runs anything here. Stages B3 (fenced proposal runs) and B4
(heartbeat autopilot) are sketched in §B9 and deliberately **not** built: their value depends on
the classification in §B4 being trustworthy, which this document exists to test for the price of
one extra field in a model call that already runs.

---

## B2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| B1 | **The Board is a mode of the existing dashboard**, not a second tab: a `Favorites ⇄ Board` switch in the one Session Deck tab | Decided 2026-09-16. The review payload is already in that webview's state; a second panel would mean a second serializer, a second push path and two things to keep in sync. The Review modal stays the per-session deep dive. |
| B2 | **Classification rides in a parallel `items[]` array**; `next_steps[]` / `blockers[]` stay plain strings | Decided 2026-09-16. Keeps D7 — reports stay interchangeable with Snippbot's `ChatReview` — and old cached reports still render. The duplication is a few hundred bytes per report and buys backward compatibility in both directions. |
| B3 | **The strings are canonical; `items[]` only annotates them.** Any `next_step`/`blocker` with no matching item is `unclassified` | A model that paraphrases its own list must not be able to invent, drop or silently retag work. Reconciliation failure degrades to "needs triage", never to a wrong tag, and `unclassified` is never eligible for automation (B8). |
| B4 | **Item state persists in `~/.session-deck/board.json`, keyed by `sessionId:hash(normalised text)`** | Decided 2026-09-16. A re-analysis rewrites a session's lists wholesale; without this you re-triage the same noise every time. Exact-text matching means a reworded item honestly reappears as new work rather than silently inheriting a "done" it never earned. |
| B5 | **No fuzzy matching, ever** | The failure mode is invisible: a wrong match hides real new work behind an old "dismissed". An item that reappears because the model reworded it is a visible, cheap annoyance; the alternative is a silent gap. |
| B6 | **Item ids are derived by Session Deck, never supplied by the model** | `hash(normalise(text))` is reproducible from the report alone, so the CLI, the host and the webview agree without coordination, and a model that emits ids cannot fork the keyspace. |
| B7 | **Seeding is still seed-don't-send (D9), and still one session at a time** | A selection spanning five sessions must not open five windows. Selected items are grouped per session into a queue; each entry is seeded on an explicit click, exactly as `Do this` does today. |
| B8 | **Nothing on the Board acts on its own.** No timers, no background runs, no writes into `~/.claude` | Stage B1–B2 changes what you can *see* and *dispatch*, not what happens without you. The rails that would make autonomy safe (worktree isolation, diff gate, budget) are B3's problem, and B3 is not built. |
| B9 | **A report with no `items[]` is out of date** | Same rule already used for the completion score: one **Analyse** upgrades every cached report to the current shape instead of leaving the Board half-populated forever. |
| B10 | **Zero extra model calls.** Classification is one more field in the review that already runs | The whole point of testing classification first is that it is nearly free. If the tag is unreliable, we learn it for pennies and B3/B4 never get built. |

---

## B3. Data model

### B3.1 `reviews/<sessionId>.json` — the `items[]` addition

`ChatReview` gains one field. Everything else is unchanged (D7).

```jsonc
{
  "…": "summary, done[], next_steps[], blockers[], priority, completion, options[] as before",
  "items": [
    {
      "id": "a3f1c92b7d04",          // derived by us: hash(normalise(text)) — not from the model
      "text": "Merge PR #42",        // copied verbatim from next_steps[] / blockers[]
      "source": "next_step",         // next_step | blocker
      "kind": "mechanical",          // mechanical | decision | user_action | unclassified
      "effort": "small"              // small | medium | large — advisory, used only for ranking
    }
  ]
}
```

**Reconciliation (B3).** After parsing, walk `next_steps[]` then `blockers[]` in order. For each
string, look for a model item whose normalised text equals it; adopt its `kind`/`effort` if found,
otherwise emit `kind: "unclassified"`. Model items matching no string are **dropped**. The result is
therefore always exactly as long as `next_steps.length + blockers.length`, in that order.

`normalise(text)` = trim, collapse internal whitespace, strip a leading list marker (`- `, `1. `),
strip trailing punctuation, lowercase. `hash` = FNV-1a 32-bit applied twice with different offsets,
rendered as 12 hex chars — pure JS so `src/shared/` stays free of Node imports and the CLI, host and
webview all derive the same id.

### B3.2 `board.json` — item state

```jsonc
{
  "version": 1,
  "items": {
    "70e8910b-…:a3f1c92b7d04": {
      "state": "done",                  // done | dismissed | seeded   (absent = open)
      "text": "Merge PR #42",           // snapshot, so a vanished item is still nameable
      "session_id": "70e8910b-…",
      "updated_at": "2026-09-16T…Z",
      "seeded_at": "2026-09-16T…Z"      // null unless it has been seeded at least once
    }
  }
}
```

Written with the same atomic write-then-rename as `favorites.json` (§4.1), watched the same way,
and pruned on load: entries whose session is no longer starred **and** whose state is `seeded` are
dropped after 30 days, so the file cannot grow without bound. `done`/`dismissed` entries are kept —
they are the record of a decision.

---

## B4. Classification — the taxonomy and how it is asked for

Three kinds, plus the honest fourth that means "the tag did not survive reconciliation".

| Kind | Means | Examples from real reports |
|---|---|---|
| `mechanical` | One obvious way to do it. No judgment that forks the code. | "Merge PR #42 once CI is green", "Update the changelog", "Delete the orphaned worktree" |
| `decision` | Needs a human choice that changes what gets built. | "Decide whether to fix the pre-existing frost-color bug", "Choose between the two store layouts" |
| `user_action` | Only the human can do it — outside any agent's reach. | "Confirm your 8 unpushed commits are pushed when ready", "Approve the Play Store submission" |
| `unclassified` | Reconciliation found no matching item (B3). Shown as needs-triage. | — |

Added to `SYSTEM_PROMPT` as a short block, and to `REVIEW_SCHEMA` as a required `items` array. The
prompt rules that matter:

- Copy each item's `text` **exactly** as it appears in `next_steps` / `blockers`. Do not reword.
- Emit one entry per item in those lists, in the same order, and nothing else.
- `decision` is the honest answer whenever doing the work commits the project to one of several
  reasonable paths — **when unsure between `mechanical` and `decision`, choose `decision`.**
- `user_action` is for things the user alone can perform, not merely things they asked for.

That last rule is deliberate asymmetry: the cost of over-tagging `decision` is one extra glance; the
cost of under-tagging it is an agent (in a later stage) making a choice that was yours.

---

## B5. Board UI

### B5.1 Anatomy

```
┌─ Session Deck ────────────────────────────────────────────────┐
│  [Favorites] [Board]                            ⚙  ↻  Review  │
├───────────────────────────────────────────────────────────────┤
│  12 open · 4 mechanical · 5 decisions · 3 yours    [kind ▾]   │
│  ☑ 2 selected      Seed into sessions…   Done   Dismiss       │
├───────────────────────────────────────────────────────────────┤
│  Review unreleased PRs merged to main        3 Medium · 90%   │
│   ☑ ⚙ Execute the release cycle              small            │
│   ☐ ◆ Approve 0.4.0 or request changes       —                │
│   ☐ ● Ensure changelog curation removes #812 medium           │
│  Snippbot daemon dashboard specs audit       2 Low · 95%      │
│   ☑ ⚙ Sweep 298 orphaned asset rows          medium           │
│   ☐ ◆ Decide whether to fix frost-color bug  small            │
└───────────────────────────────────────────────────────────────┘
```

Grouped by session, sessions ordered by `priority` desc then `lastActiveAt` desc; within a session,
blockers before next steps, then original order. Each row: checkbox · kind glyph (`⚙` mechanical,
`◆` decision, `●` user action, `?` unclassified) · text · effort · per-row **Do this** (the existing
single-item seed). Each session header links to its Review card.

### B5.2 Filters and state

- Kind filter (multi-select chips), and a **Show done/dismissed** toggle — off by default, so the
  board is what is outstanding.
- Checking a row is selection, not completion. **Done** and **Dismiss** are explicit bulk actions;
  both write `board.json` and grey the row out of the default view.
- An item whose session has no report yet, or whose report is out of date, is shown with the
  session's existing stale badge — the Board never pretends a stale list is current.
- Empty state: if nothing is starred, the favorites tip deck; if starred but unreviewed, a direct
  **Analyse N sessions** button (the modal's own action, no new path).

### B5.3 Prefs

`view`/`verbose`/`collapsed` already persist in `globalState` (§8); the Board adds `mode`
(`favorites | board`), `kinds` (filter) and `showClosed`, same mechanism, same message.

---

## B6. Seeding a selection (stage 2)

1. Selected items are grouped by session, preserving board order.
2. For each session one prompt is composed. A single item uses the existing `promptForItem`
   template unchanged; two or more use:

   ```
   Work through these items from our last review of this session:

   1. Merge PR #42 and confirm CI passed
   2. Update the changelog for 0.4.0

   Do the straightforward parts yourself. If any of them needs a decision that would fork
   the work, stop and ask me before doing it. When you are done, summarise what changed and
   what still remains.
   ```

3. The result is a **queue** rendered in the bulk bar: one entry per session, each showing the
   session title, item count and a **Seed** button; seeding opens that session through
   `SessionOpener` exactly as today (panel / already-open clipboard path / new window), marks those
   items `seeded`, and removes the entry. A **Copy** button per entry puts the prompt on the
   clipboard without opening anything.
4. Nothing is sent. `seeded` is a hint for you, not a claim that the work happened; the item stays
   on the board until the next review no longer lists it, or until you mark it done.

---

## B7. Architecture — what is added

| File | Role |
|---|---|
| `src/shared/board.ts` | `BoardItemKind`, `ReviewItem`, `normaliseItemText`, `itemIdOf`, `promptForItems`, `reconcileItems`. No Node, no vscode — shared with the webview and the CLI. |
| `src/store/BoardStore.ts` | `board.json`: load, `setState`, `setStates` (bulk), prune, atomic write, dir watch. Mirrors `FavoritesStore`. |
| `src/analyze/schema.ts` | `items` in `REVIEW_SCHEMA`, the taxonomy block in `SYSTEM_PROMPT`, reconciliation in `parseReview`. |
| `src/views/dashboard/DashboardPanel.ts` | Builds `DashboardState.board` (rows joined with state + session facts); handles `boardSetState`, `boardSeed`, `setPrefs.mode`. |
| `webview/components/BoardView.tsx` | The list, grouping, filters, selection, bulk bar, seed queue. |
| `src/cli/main.ts` | `session-deck board [--kind …] [--json]` — the same queue in the terminal, for the skill. |

No new store is introduced for the queue: the seed queue is webview-local state, because it is a
transient list of clicks, not a fact about the world.

---

## B8. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **B0** | This spec | Decisions locked (done) |
| **B1** | Classification: schema + prompt + reconciliation + `ReviewItem` in the store and the CLI; staleness rule B9 | A re-analysed session's report carries a correct `items[]`; old reports load as `unclassified` and show as out of date; unit tests cover reconciliation, drop, mismatch and hash stability |
| **B2** | `BoardStore` + Board mode + filters + done/dismiss | The board lists every outstanding item across starred sessions, state survives a re-analysis and a reload |
| **B3** | Selection + seed queue (§B6) | A selection spanning two sessions produces two queue entries; seeding opens the right session with the composed prompt, marks `seeded`, never sends |
| **B4** | `session-deck board` in the CLI + README/CHANGELOG/SPEC updates | The skill can print the queue; docs describe the taxonomy honestly |
| *(later)* | **Proposal runs** — one `mechanical` item, run headless in a git worktree of the session's repo, hard budget, producing a **diff + note** to approve. Never a commit, never a push. | Not in this spec's scope; needs a run/queue/diff store Session Deck does not have |
| *(later)* | **Heartbeat** — per-favorite opt-in, spend cap, kill switch | Only once proposal runs have earned trust |

Cadence as always: implement the phase, audit it, fix what the audit finds, then the next one; E2E
at the end.

---

## B9. The stages that are not built, and what they would need

Recorded so the shape is not re-derived later, and so B1–B4 do not accidentally foreclose it.

- **Escalation cannot be a blocking question.** A headless `claude -p` run has no interactive
  question tool. A proposal run must *emit* a question in its structured output and stop; Session
  Deck raises it in the UI on your next visit. Any design that assumes "the agent asks you" is
  wrong at the harness level.
- **Isolation is non-negotiable.** A run works in a `git worktree` of the session's repo, so a bad
  run is a directory you delete. It never resumes the user's real session (that would append
  agent turns to a transcript the user has not read, and change the fingerprint, which restales the
  report, which re-triggers the heartbeat).
- **Cost is not review-shaped.** A review is a read: 3–7¢ on haiku. An agentic loop with edits and
  test runs is $0.30–$3 per item plus a re-review. Budgets must be per-run *and* per-day, enforced
  in Session Deck, not requested of the model.
- **The missing machinery** is not the prompt: it is a run queue, persisted run state, a diff store,
  budget accounting and a kill switch. That is the bulk of the work, and none of it exists today.

---

## B10. Risks

| Risk | Mitigation |
|---|---|
| The model classifies badly, and the Board's whole premise fails | That is what B1 tests, for the price of one field. `unclassified` and the "when unsure, choose `decision`" rule make the failure visible rather than silent; nothing acts on the tag in B1–B4 |
| Re-analysis churns item text, so state keeps resetting | B4/B5 accept this openly: exact match or nothing. If churn proves severe in practice, the fix is asking the model for stable phrasing, not fuzzy matching |
| The Board becomes a to-do app people expect to sync | It is a projection of reviews plus a thin state file. `done`/`dismissed` are annotations on a derived list; the source of truth is always the transcript |
| `board.json` grows forever | Pruned on load (§B3.2): `seeded` entries for unstarred sessions expire after 30 days; decisions are kept |
| Adding a required schema field breaks reports from an older Session Deck, or from Snippbot | `items` is additive and optional on read (B2); a report without it loads fine and is simply marked out of date (B9) |
