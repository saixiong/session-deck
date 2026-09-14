import { useState } from 'preact/hooks'
import type { TipDeck } from '../tipContent'

interface Props {
  deck: TipDeck
  /** Optional link under the pinned instruction. */
  cta?: { label: string; onClick: () => void }
}

/**
 * One rotating tip plus the pinned `howToAdd` (spec §8.1; Snippbot §9.5).
 * The start index is chosen ONCE per mount in the state initialiser — never
 * during render — so a background state push cannot reshuffle the tip while
 * it is being read. Arrows wrap; a one-tip deck shows no arrows.
 */
export function SectionTipStrip({ deck, cta }: Props) {
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * Math.max(1, deck.tips.length))
  )
  const tips = deck.tips
  const tip = tips[Math.min(index, tips.length - 1)]
  const step = (delta: number) => setIndex((i) => (i + delta + tips.length) % tips.length)
  return (
    <div class="tip" role="note">
      <div class="tip__row">
        <div class="tip__body" aria-live="polite">
          <span class="codicon codicon-lightbulb" aria-hidden="true" />
          {tip ? (
            <p>
              <strong>{tip.title}.</strong> {tip.body}
            </p>
          ) : null}
        </div>
        {tips.length > 1 ? (
          <div class="tip__nav">
            <button
              class="control control--icon"
              type="button"
              aria-label="Previous tip"
              onClick={() => step(-1)}
            >
              <span class="codicon codicon-chevron-left" aria-hidden="true" />
            </button>
            <span class="tip__pos" aria-label={`Tip ${index + 1} of ${tips.length}`}>
              {index + 1}/{tips.length}
            </span>
            <button
              class="control control--icon"
              type="button"
              aria-label="Next tip"
              onClick={() => step(1)}
            >
              <span class="codicon codicon-chevron-right" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      <div class="tip__how">
        {deck.howToAdd}
        {cta ? (
          <>
            {' '}
            <button class="link" type="button" onClick={cta.onClick}>
              {cta.label} →
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
