import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
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
    <details className="rounded-lg border p-3" title={disabled ? disabledTooltip : undefined}>
      <summary className="cursor-pointer text-sm font-medium">Decay &amp; health</summary>
      <div className="mt-3 space-y-4">
        <p className="text-xs text-muted-foreground">
          Cell health is confidence derived from validated neighbors in the example-retrieval
          graph (AD-14). Health is <code>1 − mean(decay)</code> over translated cells.
        </p>

        <div>
          <Label htmlFor="decay-max-hops">Max hops</Label>
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
          <p className="mt-1 text-xs text-muted-foreground">
            Propagation radius from validated cells. Larger values let confidence
            ripple further through the retrieval graph. Default {DEFAULT_MAX_HOPS}.
          </p>
        </div>

        <div>
          <Label htmlFor="decay-warn">Attention threshold</Label>
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
          <p className="mt-1 text-xs text-muted-foreground">
            Decay above this shows the cell&apos;s &quot;needs attention&quot; marker (0–1). Default {DECAY_DEFAULTS.decayWarnThreshold}.
          </p>
        </div>
      </div>
    </details>
  )
}
