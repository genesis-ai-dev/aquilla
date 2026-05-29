import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import type { DecaySettings } from "@/lib/parsers/types"
import { DECAY_DEFAULTS } from "@/lib/health/decay-engine"

interface DecaySettingsSectionProps {
  settings?: DecaySettings
  /**
   * The project's required-validations gate. When no explicit endorsement
   * target is set, the target defaults to this so a validated cell reaches full
   * health (matches resolveDecayConfig at runtime).
   */
  requiredValidations: number
  onChange: (next: DecaySettings) => void
  disabled?: boolean
  disabledTooltip?: string
}

/**
 * AD-14 decay tunables. Replaces the retired four-sub-score "health settings"
 * section. Health = 1 - mean(decay); decay = max(0, 1 - endorsements/target).
 */
export function DecaySettingsSection({
  settings,
  requiredValidations,
  onChange,
  disabled,
  disabledTooltip,
}: DecaySettingsSectionProps) {
  const endorsementTarget = settings?.endorsementTarget ?? requiredValidations
  const decayWarnThreshold = settings?.decayWarnThreshold ?? DECAY_DEFAULTS.decayWarnThreshold

  return (
    <details className="rounded-lg border p-3" title={disabled ? disabledTooltip : undefined}>
      <summary className="cursor-pointer text-sm font-medium">Decay &amp; health</summary>
      <div className="mt-3 space-y-4">
        <p className="text-xs text-muted-foreground">
          A cell&apos;s decay drops as it accrues endorsements (a validated cell endorses
          itself and its retrieval neighborhood, AD-14). Health is <code>1 − mean(decay)</code>.
        </p>

        <div>
          <Label htmlFor="decay-target">Endorsement target</Label>
          <Input
            id="decay-target"
            type="number"
            min={1}
            max={50}
            step={1}
            value={endorsementTarget}
            disabled={disabled}
            onChange={(e) => {
              const v = Math.max(1, Math.round(Number(e.target.value) || 0))
              onChange({ ...settings, endorsementTarget: v })
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Endorsements at which a cell reaches decay 0 (full health). Defaults to the
            project&apos;s required validations ({requiredValidations}).
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
