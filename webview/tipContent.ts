/**
 * Section tip decks (spec §8.1; Snippbot §9.5). The empty state IS the
 * onboarding: every section always renders, and an empty one teaches its
 * surface. `howToAdd` is pinned — it is the instruction, never rotated away.
 *
 * `deckFor` never returns undefined: an entity type with no copy gets a deck
 * worded from its heading, so a newer host cannot blank the page (A17-1).
 */
export interface SectionTip {
  id: string
  title: string
  body: string
}

export interface TipDeck {
  howToAdd: string
  tips: SectionTip[]
}

const SESSION_DECK: TipDeck = {
  howToAdd:
    'To add: star a session in the Session Deck sidebar, press Add here, or run “Session Deck: Favorite Current Session” from the Command Palette.',
  tips: [
    {
      id: 'session-what-counts',
      title: 'What a favorite is for',
      body: 'Star the sessions you keep coming back to — the long-running feature, the audit you resume every morning. The Recent list is for everything else.',
    },
    {
      id: 'session-review',
      title: 'Review before you resume',
      body: 'Review sessions reads each starred transcript and reports what is done, what is left, what is blocked, and a priority — so you pick the right one to open first.',
    },
    {
      id: 'session-directions',
      title: 'Directions are typed, not sent',
      body: 'A review offers two to four next steps. Choosing one opens the session with that prompt waiting in the composer; nothing is sent until you press Enter.',
    },
    {
      id: 'session-cross-project',
      title: 'Sessions from other projects',
      body: 'A favorite from another repository opens in a new window on that folder — Claude Code only resumes sessions that belong to the folder it is running in.',
    },
    {
      id: 'session-hidden-sdk',
      title: 'Where did my sessions go?',
      body: 'Transcripts produced by SDK or headless runs are hidden by default. Turn on “Show SDK sessions” in settings to list them.',
    },
    {
      id: 'session-live',
      title: 'Live means running now',
      body: 'A pulsing dot marks a session with a Claude Code process still attached. Live sessions that are not starred sit in their own strip below.',
    },
    {
      id: 'session-list-view',
      title: 'Titles are not enough',
      body: 'Two sessions with similar titles are told apart by their preview — the tail of the last reply. Switch to the list view or keep Verbose on to see it.',
    },
  ],
}

const DECKS: Record<string, TipDeck> = { session: SESSION_DECK }

export function deckFor(entityType: string, label: string): TipDeck {
  return (
    DECKS[entityType] ?? {
      howToAdd: `To add: star a ${label.toLowerCase().replace(/s$/, '')} from its list, or press Add here.`,
      tips: [
        {
          id: `${entityType}-fallback`,
          title: label,
          body: `Starred ${label.toLowerCase()} appear here. This build has no tips for them yet.`,
        },
      ],
    }
  )
}
