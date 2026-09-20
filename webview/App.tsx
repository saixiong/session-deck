import { useCallback, useEffect, useState } from 'preact/hooks'
import type { FavoriteEntityType } from '../src/shared/cards'
import type { CandidatesPayload, DashboardState, Period } from '../src/shared/messages'
import { PERIODS } from '../src/shared/messages'
import { onHostMessage, post } from './vscodeApi'
import { FavoritesSection } from './components/FavoritesSection'
import { BoardView } from './components/BoardView'
import { PickerModal } from './components/PickerModal'
import { ReviewModal } from './components/ReviewModal'
import { SearchBox } from './components/SearchBox'
import { Shelf } from './components/Shelf'
import { Stack } from './components/Stack'
import { StatStrip } from './components/StatStrip'

interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
}

/**
 * The dashboard (spec §8). Header controls → stat strip → one curated section
 * per registered entity type (always rendered) → Live now → Suggested.
 * All data arrives as one `state` message; the webview keeps only UI state
 * (open picker, toasts).
 */
export function App() {
  const [state, setState] = useState<DashboardState | null>(null)
  const [picker, setPicker] = useState<{ entityType: FavoriteEntityType; label: string } | null>(
    null
  )
  const [candidates, setCandidates] = useState<CandidatesPayload | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [reviewOpen, setReviewOpen] = useState<{ focus: string | null } | null>(null)

  useEffect(() => {
    const off = onHostMessage((message) => {
      switch (message.type) {
        case 'state':
          setState(message.state)
          return
        case 'candidates':
          setCandidates(message.payload)
          return
        case 'showReview':
          setReviewOpen({ focus: message.focus })
          return
        case 'toast': {
          const id = Date.now() + Math.random()
          setToasts((t) => [...t, { id, level: message.level, text: message.text }])
          setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
          return
        }
      }
    })
    post({ type: 'ready' })
    return off
  }, [])

  const closePicker = useCallback(() => {
    setPicker(null)
    setCandidates(null)
  }, [])

  if (!state) {
    return (
      <main class="deck deck--loading" aria-busy="true">
        <p class="muted">Connecting to the extension host…</p>
      </main>
    )
  }

  const { prefs } = state
  const searching = state.search.query.trim().length > 0
  const boardOpen = state.board.rows.filter((r) => r.state === null || r.state === 'seeded').length
  const setPrefs = (patch: Partial<typeof prefs>) => post({ type: 'setPrefs', prefs: patch })
  const favoritedByType = new Map<FavoriteEntityType, Set<string>>()
  for (const g of state.groups)
    favoritedByType.set(g.entityType, new Set(g.items.map((i) => i.entityId)))

  return (
    <main class="deck">
      <header class="deck__header">
        <h1 class="deck__title">
          <span class="codicon codicon-dashboard" aria-hidden="true" /> Session Deck
        </h1>
        <div class="deck__controls" role="group" aria-label="View options">
          <span class="segmented" role="group" aria-label="Mode">
            <button
              class="control"
              type="button"
              aria-pressed={prefs.mode !== 'board'}
              onClick={() => setPrefs({ mode: 'favorites' })}
            >
              <span class="codicon codicon-star-full" aria-hidden="true" /> Favorites
            </button>
            <button
              class="control"
              type="button"
              aria-pressed={prefs.mode === 'board'}
              title="Everything your starred sessions still owe you, in one list"
              onClick={() => setPrefs({ mode: 'board' })}
            >
              <span class="codicon codicon-checklist" aria-hidden="true" /> Board
              {boardOpen ? <span class="pill">{boardOpen}</span> : null}
            </button>
          </span>
          <SearchBox search={state.search} />
          <select
            class="control"
            aria-label="Period"
            value={state.period}
            onChange={(e) => post({ type: 'setPeriod', period: e.currentTarget.value as Period })}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span class="segmented" role="group" aria-label="Layout">
            <button
              class="control"
              type="button"
              aria-pressed={prefs.view === 'grid'}
              title="Grid view"
              onClick={() => setPrefs({ view: 'grid' })}
            >
              <span class="codicon codicon-layout" aria-hidden="true" />
            </button>
            <button
              class="control"
              type="button"
              aria-pressed={prefs.view === 'list'}
              title="List view"
              onClick={() => setPrefs({ view: 'list' })}
            >
              <span class="codicon codicon-list-flat" aria-hidden="true" />
            </button>
          </span>
          <button
            class="control"
            type="button"
            aria-pressed={prefs.verbose}
            title="Verbose: show previews and details"
            onClick={() => setPrefs({ verbose: !prefs.verbose })}
          >
            <span class="codicon codicon-note" aria-hidden="true" /> Verbose
          </button>
          <button
            class="control control--icon"
            type="button"
            title="Refresh index"
            aria-label="Refresh index"
            onClick={() => post({ type: 'command', command: 'reload' })}
          >
            <span class="codicon codicon-refresh" aria-hidden="true" />
          </button>
        </div>
      </header>

      <StatStrip tiles={state.stats} />

      {prefs.mode === 'board' ? (
        <div class="stack">
          <div class="pane pane--open" style={{ flex: '1 1 0px' }}>
            <BoardView
              board={state.board}
              prefs={prefs}
              onReview={(focus) => setReviewOpen({ focus })}
              searching={searching}
            />
          </div>
        </div>
      ) : (
        <Stack
          sizes={prefs.sizes}
          onSizes={(sizes) => setPrefs({ sizes })}
          panes={[
            ...state.groups.map((group) => ({
              id: group.entityType,
              open: !(prefs.collapsed[group.entityType] ?? false),
              node: (
                <FavoritesSection
                  key={group.entityType}
                  group={group}
                  prefs={prefs}
                  workspaceKeys={state.workspaceKeys}
                  onAdd={() => setPicker({ entityType: group.entityType, label: group.label })}
                  onReview={
                    group.entityType === 'session' ? (focus) => setReviewOpen({ focus }) : undefined
                  }
                  reviewEnabled={group.items.length > 0 || state.review.extraIds.length > 0}
                  reviews={group.entityType === 'session' ? state.review.reviews : undefined}
                  searching={searching}
                />
              ),
            })),
            {
              id: 'live',
              open: !(prefs.collapsed['live'] ?? true),
              node: (
                <Shelf
                  id="live"
                  title="Live now"
                  icon="pulse"
                  cards={state.live}
                  prefs={prefs}
                  emptyText="No running Claude Code session that isn't already starred."
                />
              ),
            },
            {
              id: 'suggested',
              open: !(prefs.collapsed['suggested'] ?? true),
              hidden: !searching && state.suggested.length === 0,
              node: (
                <Shelf
                  id="suggested"
                  title={searching ? 'Matches' : 'Suggested'}
                  subtitle={
                    searching
                      ? 'sessions matching your search, not shown above'
                      : 'recently active, not yet starred'
                  }
                  icon={searching ? 'search' : 'sparkle'}
                  cards={state.suggested}
                  prefs={prefs}
                  emptyText={searching ? 'No other sessions match.' : ''}
                  hideWhenEmpty={!searching}
                />
              ),
            },
          ]}
        />
      )}

      {picker ? (
        <PickerModal
          entityType={picker.entityType}
          label={picker.label}
          candidates={candidates && candidates.entityType === picker.entityType ? candidates : null}
          favoritedIds={favoritedByType.get(picker.entityType) ?? new Set()}
          onClose={closePicker}
        />
      ) : null}

      {reviewOpen ? (
        <ReviewModal
          group={state.groups.find((g) => g.entityType === 'session')}
          review={state.review}
          focus={reviewOpen.focus}
          onClose={() => setReviewOpen(null)}
        />
      ) : null}

      {toasts.length ? (
        <div class="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div class={`toast toast--${t.level}`} key={t.id}>
              {t.text}
            </div>
          ))}
        </div>
      ) : null}

      <footer class="deck__footer muted">
        {state.index.scanning
          ? `Indexing ${state.index.complete} of ${state.index.total} sessions…`
          : `${state.index.total} sessions indexed`}{' '}
        · Session Deck v{state.extensionVersion}
      </footer>
    </main>
  )
}
