# SPEC — Search: find a session by what it is about

Status: **Draft**, 2026-09-18. Extends [SPEC.md](SPEC.md) and [SPEC_BOARD.md](SPEC_BOARD.md); every
decision there holds. Sections numbered `S*`.

---

## S1. What this is

One search box, two surfaces, one matcher. Typing in the dashboard header filters every list the
dashboard shows — favorites, live, suggested, the Board — and turns the Suggested shelf into a
list of *every* matching session, starred or not, so search reaches the 850 sessions the shelf
never lists. A magnifier on the sidebar view runs the same matcher over the tree.

Two stages. **S1** matches what the index already knows about a session — its title, first and
last prompt, last-reply preview, project, branches, linked PRs, id prefix. Instant, nothing new
stored, but a word buried in the middle of a transcript is invisible to it. **S2** adds a content
index so that word is found too, with results saying where they matched.

## S2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| S1 | **Both surfaces run the same `matchesQuery(entry, query)`** from `src/index/search.ts` | Decided 2026-09-18. A session the tree finds that the dashboard does not (or vice versa) is a bug report waiting to happen. The picker's private matcher moves here and both grow together. |
| S2 | **Filtering is host-side**; the webview sends the query, the host sends filtered state | The webview's cards carry a title, a subtitle and a preview; the matcher reads six more fields. Filtering where the data is means the two surfaces cannot drift, at the cost of one debounced round trip (150 ms, the picker's) per keystroke. |
| S3 | **Words are ANDed, case-insensitive, anywhere in the field**; no fuzzy matching, no ranking | The picker's rule. Fuzzy search on 892 titles returns noise the user must then read; recency order, which every list already uses, is a better tiebreak than a relevance score nobody can predict. |
| S4 | **A query is view state, not a fact** — never persisted, never in `globalState`, per window | A search left over from yesterday is the most confusing empty dashboard there is. Dashboard state survives a tab switch (`retainContextWhenHidden`) and dies with the window; the tree filter dies with the window. |
| S5 | **The tree filters through a title-bar input, not a rewrite** | Decided 2026-09-18 with Sai. Tree views cannot host a text box; an input box on the magnifier keeps VS Code's own tree — collapse-all, context menus, keyboard navigation — which a webview view would have to reimplement. |
| S6 | **Stats stay unfiltered** | The stat strip describes the period, not the list; "3 live" while searching for `login` is still true. |
| S7 | **S2's content index lives in Session Deck's cache, never in `~/.claude`** (D5) and is built incrementally from the byte offset the indexer already tracks (D8) | Same rules that made the metadata index safe. |

## S3. Matching (S1)

`normaliseQuery(q)` lowercases, trims and splits on whitespace into words; an empty result matches
everything. `matchesQuery(entry, words)` is true when **every** word occurs in at least one of:

`resolveTitle(entry)` · `firstPrompt` · `lastPrompt` · `preview` · `projectLabel(entry)` ·
each of `gitBranches` · each PR as `#<number>` · `sessionId` (prefix match only, ≥ 4 chars).

Missing sessions match on their favorite label alone. Live sessions with no transcript yet match on
their live name.

## S4. Dashboard (S1)

- A search input in the header, before the period selector, with a clear button and the count
  `12 of 892` while a query is active. Escape clears.
- With a query: favorites groups show only matching items (a group with none is hidden, but the
  section stays — D9's always-render rule), Live shows matching live cards, the Board shows rows of
  matching sessions, and **Suggested becomes "Matches"**: every matching visible session not
  already shown above, newest first, capped at 50. The Review modal lists what the favorites
  section lists, so it follows.
- `DashboardState.search = { query, matched, total }`; the webview posts `setSearch { query }`.

## S5. Sidebar (S1)

- A magnifier on the view title opens an input box (prefilled with the current filter). A second
  title icon, **Clear filter**, appears only while a filter is active (`sessionDeck.treeFilterActive`).
- While filtering: every section lists only matching sessions, project groups with none vanish,
  the remaining groups render expanded, Recent paging is off (a filter is already a page), the
  view's description reads `filter: <query>`, and a **Clear filter** row sits at the top.

## S6. Content index (S2 — not built)

A per-session text file in `<cache>/content/<sessionId>.txt`: user and assistant text only,
appended from the indexer's full pass at the byte offset it already tracks. Search scans these
files with the same word rule; a hit adds `where: 'content'` and a 120-character snippet to the
result, and the dashboard labels such rows *matched in transcript*. Largest files last, same as
the index. Nothing is built until S1 has been used enough to know whether it is missed.

## S7. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **S0** | This spec | Decisions locked (done) |
| **S1** | `index/search.ts` + dashboard box + tree filter | The same query gives the same sessions on both surfaces; unit tests cover the matcher's fields and the AND rule; e2e covers the tree filter |
| **S2** | Content index + `where`/snippet in results | A word that appears only mid-transcript is found on both surfaces; the index is incremental and never reads a file twice |

Cadence as always: implement, audit, fix, next; E2E at the end.
