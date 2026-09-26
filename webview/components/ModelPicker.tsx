import type { ModelOptionView } from '../../src/shared/messages'
import { post } from '../vscodeApi'

/**
 * Which model the analysis runs on (next to Analyse, per the request). The
 * host owns the list and the choice — picking one writes the `sessionDeck.model`
 * setting, so it is the same choice the skill CLI and the next window use.
 *
 * Refresh re-reads Claude Code's own cached model list and the models seen in
 * indexed sessions. There is no models endpoint to call without an API key, so
 * the aliases carry the "latest" guarantee: each resolves to the newest model
 * of its family on every run.
 */
export function ModelPicker({
  model,
  models,
  disabled,
}: {
  model: string
  models: ModelOptionView[]
  disabled: boolean
}) {
  const chosen = models.find((m) => m.value === model)
  const groups: Array<{ label: string; of: ModelOptionView['source'][] }> = [
    { label: 'Latest of each family', of: ['default', 'alias'] },
    { label: 'From Claude Code', of: ['claude'] },
    { label: 'Seen in your sessions', of: ['seen'] },
  ]
  return (
    <span class="modelpick">
      <label class="modelpick__label muted" for="review-model">
        Model
      </label>
      <select
        id="review-model"
        class="control modelpick__select"
        value={model}
        disabled={disabled}
        title={chosen?.description ?? 'Model the analysis runs on'}
        onChange={(e) => post({ type: 'setModel', model: e.currentTarget.value })}
      >
        {groups.map(({ label, of }) => {
          const rows = models.filter((m) => of.includes(m.source))
          if (rows.length === 0) return null
          return (
            <optgroup key={label} label={label}>
              {rows.map((m) => (
                <option key={m.value} value={m.value} title={m.description ?? m.value}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
      <button
        class="control control--icon"
        type="button"
        title="Re-read the models Claude Code knows about"
        aria-label="Refresh model list"
        disabled={disabled}
        onClick={() => post({ type: 'refreshModels' })}
      >
        <span class="codicon codicon-refresh" aria-hidden="true" />
      </button>
    </span>
  )
}
