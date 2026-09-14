import { useEffect, useState } from 'preact/hooks'
import type { DashboardState } from '../src/shared/messages'
import { onHostMessage, post } from './vscodeApi'
import { StatStrip } from './components/StatStrip'
import { Section } from './components/Section'

/**
 * The dashboard shell. P0 renders the real layout — header, stat strip, the
 * always-present Favorites section, and the shelves — over placeholder data,
 * so the theme work and the message plumbing are proven before any of the
 * data exists.
 */
export function App() {
  const [state, setState] = useState<DashboardState | null>(null)

  useEffect(() => {
    const off = onHostMessage((message) => {
      if (message.type === 'state') setState(message.state)
    })
    post({ type: 'ready' })
    return off
  }, [])

  if (!state) {
    return (
      <main class="deck deck--loading" aria-busy="true">
        <p class="muted">Connecting to the extension host…</p>
      </main>
    )
  }

  return (
    <main class="deck">
      <header class="deck__header">
        <h1 class="deck__title">
          <span class="codicon codicon-dashboard" aria-hidden="true" /> Session Deck
        </h1>
        <div class="deck__controls" role="group" aria-label="View options">
          <select class="control" aria-label="Period" disabled>
            <option>24h</option>
          </select>
          <button class="control" type="button" disabled aria-pressed="true" title="Grid view">
            <span class="codicon codicon-layout" aria-hidden="true" />
          </button>
          <button class="control" type="button" disabled title="List view">
            <span class="codicon codicon-list-flat" aria-hidden="true" />
          </button>
          <button
            class="control control--icon"
            type="button"
            title="Reload"
            onClick={() => post({ type: 'command', command: 'reload' })}
          >
            <span class="codicon codicon-refresh" aria-hidden="true" />
          </button>
        </div>
      </header>

      <StatStrip tiles={state.stats} />

      <Section
        title="Favorites"
        count={0}
        icon="star-full"
        actions={
          <button class="button button--primary" type="button" disabled>
            Review sessions
          </button>
        }
      >
        <div class="tip" role="note">
          <div class="tip__body" aria-live="polite">
            <span class="codicon codicon-lightbulb" aria-hidden="true" />
            <p>
              <strong>Nothing starred yet.</strong> Once the session index is in place (P1), star a
              session from the Session Deck sidebar or run{' '}
              <kbd>Session Deck: Favorite current session</kbd>.
            </p>
          </div>
          <div class="tip__how">
            Scaffold build — phase {state.phase}, v{state.extensionVersion}.
          </div>
        </div>
      </Section>

      <Section title="Live now" count={0} icon="pulse" quiet>
        <p class="muted">Running Claude Code sessions will appear here.</p>
      </Section>

      <Section
        title="Suggested"
        subtitle="recently active, not yet starred"
        count={0}
        icon="sparkle"
        quiet
      >
        <p class="muted">Recent sessions will appear here.</p>
      </Section>
    </main>
  )
}
