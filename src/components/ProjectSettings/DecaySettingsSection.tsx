import { Input } from "@/components/ui/input"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { AppTooltip } from "@/components/ui/tooltip"
import type { DecaySettings } from "@/lib/parsers/types"
import { DECAY_DEFAULTS } from "@/lib/health/decay-engine"

// AD-14 amendment 2026-06-04: default maxHops for the confidence propagation.
const DEFAULT_MAX_HOPS = 4

interface DecaySettingsSectionProps {
  settings?: DecaySettings
  onChange: (next: DecaySettings) => void
  disabled?: boolean
  disabledTooltip?: string
}

/**
 * AD-14 decay tunables. Exposes `maxHops` (confidence propagation radius) and
 * `decayWarnThreshold`. The retired `endorsementTarget` field is no longer
 * shown — confidence is now derived on read via the example-retrieval graph,
 * not counted from write-time endorsement events (AD-14 amendment 2026-06-04).
 */
export function DecaySettingsSection({
  settings,
  onChange,
  disabled,
  disabledTooltip,
}: DecaySettingsSectionProps) {
  const maxHops = settings?.maxHops ?? DEFAULT_MAX_HOPS
  const decayWarnThreshold = settings?.decayWarnThreshold ?? DECAY_DEFAULTS.decayWarnThreshold

  return (
    <AppTooltip content={disabledTooltip} disabled={!disabled}>
      <div>
        <SettingsGroup label="Retrieval support">
          <SettingsRow
            label={<label htmlFor="decay-max-hops">Max hops</label>}
            description={`Propagation radius from approved cells. Larger values let support ripple further through the retrieval graph. Default ${DEFAULT_MAX_HOPS}.`}
            control={
              <Input
                id="decay-max-hops"
                type="number"
                min={1}
                max={20}
                step={1}
                value={maxHops}
                disabled={disabled}
                aria-label="Max hops"
                className="w-24 bg-background"
                onChange={(e) => {
                  const v = Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 0)))
                  onChange({ ...settings, maxHops: v })
                }}
              />
            }
          />
          <SettingsRow
            label={<label htmlFor="decay-warn">Attention threshold</label>}
            description={`Low support beyond this threshold shows the cell's review-priority marker (0–1). Default ${DECAY_DEFAULTS.decayWarnThreshold}.`}
            control={
              <Input
                id="decay-warn"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={decayWarnThreshold}
                disabled={disabled}
                aria-label="Attention threshold"
                className="w-24 bg-background"
                onChange={(e) => {
                  const v = Math.min(1, Math.max(0, Number(e.target.value) || 0))
                  onChange({ ...settings, decayWarnThreshold: v })
                }}
              />
            }
          />
        </SettingsGroup>
        <p className="mt-2 px-4 text-xs text-muted-foreground">
          This support signal measures proximity to approved neighboring cells in the retrieval
          graph. It can prioritize review, but it is not a translation-quality score and never
          removes the human-review requirement.
        </p>
      </div>
    </AppTooltip>
  )
}
