import { useEffect, useRef, useState } from 'preact/hooks'
import type { FavoriteEntityType } from '../../src/shared/cards'
import { formatTimeDistance } from '../../src/shared/cards'
import type { CandidatesPayload } from '../../src/shared/messages'
import { post } from '../vscodeApi'
import { Modal } from './Modal'

interface Props {
  entityType: FavoriteEntityType
  label: string
  /** The latest candidates payload for this type, or null while loading. */
  candidates: CandidatesPayload | null
  /** Ids currently favorited — the source of truth for ticks (optimistic on click). */
  favoritedIds: ReadonlySet<string>
  onClose: () => void
}

const LIMIT = 100

/**
 * The per-section picker (spec §8.3; Snippbot D12/§9.7). One component for
 * every type: rows are FavoriteCards, so it renders a title / subtitle /
 * preview / tick and never learns what a "session" is. No Save button: each
 * tick is its own star, sent immediately. Candidates are requested only
 * while the modal is open, because browse() may scan.
 */
export function PickerModal({ entityType, label, candidates, favoritedIds, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [onlyLive, setOnlyLive] = useState(false)
  const [onlyPr, setOnlyPr] = useState(false)
  // Optimistic ticks: the host's push lags a click by a few hundred ms.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map())
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    const handle = setTimeout(
      () => post({ type: 'browse', entityType, query, limit: LIMIT }),
      query ? 150 : 0
    )
    return () => clearTimeout(handle)
  }, [entityType, query])

  // Once the host confirms, drop the optimistic override.
  useEffect(() => {
    if (pending.size === 0) return
    const next = new Map(pending)
    for (const [id, wanted] of pending) if (favoritedIds.has(id) === wanted) next.delete(id)
    if (next.size !== pending.size) setPending(next)
  }, [favoritedIds, pending])

  const isOn = (id: string) => pending.get(id) ?? favoritedIds.has(id)
  const toggle = (id: string, title: string) => {
    setPending((m) => new Map(m).set(id, !isOn(id)))
    post({ type: 'toggleFavorite', entityType, entityId: id, label: title })
  }

  const items = (candidates?.items ?? []).filter((c) => {
    if (onlyLive && c.status !== 'live') return false
    if (onlyPr && !c.details.some((d) => d.kind === 'link')) return false
    return true
  })
  const loading = candidates === null || candidates.query !== query
  const truncated = candidates ? candidates.total > candidates.items.length : false

  return (
    <Modal title={`Add ${label.toLowerCase()}`} onClose={onClose} width="wide">
      <div class="picker__bar">
        <input
          ref={input}
          class="input"
          type="search"
          placeholder={`Search ${label.toLowerCase()} by title, first prompt, project, branch or PR…`}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search"
        />
        <label class="check">
          <input type="checkbox" checked={onlyLive} onChange={() => setOnlyLive((v) => !v)} /> live
        </label>
        <label class="check">
          <input type="checkbox" checked={onlyPr} onChange={() => setOnlyPr((v) => !v)} /> has PR
        </label>
      </div>
      <p class="muted picker__count" aria-live="polite">
        {loading
          ? 'Loading…'
          : candidates
            ? `${items.length} of ${candidates.total} ${label.toLowerCase()}${truncated ? ` — showing the ${candidates.items.length} most recent; refine the search to see others` : ''}`
            : ''}
      </p>
      <ul class="picker__list" aria-busy={loading}>
        {items.map((c) => {
          const on = isOn(c.entityId)
          return (
            <li class={`picker__row${on ? ' picker__row--on' : ''}`} key={c.entityId}>
              <label class="picker__label">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(c.entityId, c.title)}
                  aria-label={`Favorite ${c.title}`}
                />
                <span class="picker__text">
                  <span class="picker__title">
                    {c.status === 'live' ? <span class="dot dot--success" title="live" /> : null}
                    {c.title}
                  </span>
                  <span class="picker__sub muted">
                    {[c.subtitle, formatTimeDistance(c.updatedAt)].filter(Boolean).join(' · ')}
                  </span>
                  {c.preview ? <span class="picker__preview">{c.preview}</span> : null}
                </span>
              </label>
            </li>
          )
        })}
        {!loading && items.length === 0 ? (
          <li class="muted picker__empty">Nothing matches.</li>
        ) : null}
      </ul>
    </Modal>
  )
}
