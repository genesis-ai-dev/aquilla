import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
    <details className="rounded-lg border p-3">
      <AppTooltip content={disabledTooltip} disabled={!disabled}>
        <summary className="cursor-pointer text-sm font-medium">Retrieval support</summary>
      </AppTooltip>
      <div className="mt-3 space-y-4">
        <p className="text-xs text-muted-foreground">
          This support signal measures proximity to approved neighboring cells in the retrieval
          graph. It can prioritize review, but it is not a translation-quality score and never
          removes the human-review requirement.
        </p>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="decay-max-hops">Max hops</FieldLabel>
            <Input
              id="decay-max-hops"
              type="number"
              min={1}
              max={20}
              step={1}
              value={maxHops}
              disabled={disabled}
              onChange={(e) => {
                const v = Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 0)))
                onChange({ ...settings, maxHops: v })
              }}
            />
            <FieldDescription>
              Propagation radius from approved cells. Larger values let support
              ripple further through the retrieval graph. Default {DEFAULT_MAX_HOPS}.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="decay-warn">Attention threshold</FieldLabel>
            <Input
              id="decay-warn"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={decayWarnThreshold}
              disabled={disabled}
              onChange={(e) => {
                const v = Math.min(1, Math.max(0, Number(e.target.value) || 0))
                onChange({ ...settings, decayWarnThreshold: v })
              }}
            />
            <FieldDescription>
              Low support beyond this threshold shows the cell&apos;s review-priority marker (0–1). Default {DECAY_DEFAULTS.decayWarnThreshold}.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </div>
    </details>
  )
}
