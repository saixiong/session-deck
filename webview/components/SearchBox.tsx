import { useEffect, useRef, useState } from 'preact/hooks'
import type { SearchState } from '../../src/shared/messages'
import { post } from '../vscodeApi'

const DEBOUNCE_MS = 150

/**
 * The dashboard's search box (SPEC_SEARCH S4). The words go to the host,
 * which filters every list with the one matcher the sidebar also uses (S1);
 * this component only owns the text while it is being typed. Escape and the
 * × clear it at once, without waiting for the debounce.
 */
export function SearchBox({ search }: { search: SearchState }) {
  const [text, setText] = useState(search.query)
  const input = useRef<HTMLInputElement>(null)
  // A panel restored by VS Code gets the host's query back; otherwise the
  // host only ever echoes what was typed here.
  const typed = useRef(text)
  typed.current = text
  useEffect(() => {
    if (search.query !== typed.current && document.activeElement !== input.current)
      setText(search.query)
  }, [search.query])
  useEffect(() => {
    if (text === search.query) return
    const handle = setTimeout(() => post({ type: 'setSearch', query: text }), DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [text, search.query])
  const clear = () => {
    setText('')
    post({ type: 'setSearch', query: '' })
  }
  const active = search.query.trim().length > 0
  return (
    <div class={`search${active ? ' search--active' : ''}`} role="search">
      <span class="codicon codicon-search search__icon" aria-hidden="true" />
      <input
        ref={input}
        class="search__input"
        type="search"
        placeholder="Search sessions"
        aria-label="Search sessions"
        value={text}
        maxLength={200}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text) {
            e.stopPropagation()
            clear()
          }
        }}
      />
      {active ? (
        <span class="search__count muted" aria-live="polite">
          {search.matched} of {search.total}
        </span>
      ) : null}
      {text ? (
        <button
          class="control control--icon search__clear"
          type="button"
          aria-label="Clear search"
          title="Clear search"
          onClick={clear}
        >
          <span class="codicon codicon-close" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
