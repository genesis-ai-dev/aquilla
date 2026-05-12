import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import type { HealthSettings, HealthConfig, RulePenalties } from "@/lib/parsers/types"
import { resolveHealthConfig } from "@/lib/health/config-resolver"

interface Props {
  settings: HealthSettings
  /** The effective rulePenalties (after `project.rulePenalties` precedence) —
   *  displayed in the major/minor inputs so both this surface and the
   *  RulesPage card show the same value at all times. */
  rulePenalties: RulePenalties
  onChange: (next: HealthSettings) => void
  /** Writes to `project.rulePenalties` (the authoritative field shared with
   *  the RulesPage "Penalty Configuration" card). */
  onRulePenaltiesChange: (next: RulePenalties) => void
  onReset: () => void
  /** When true, every input + the reset button is read-only and shows
   *  `disabledTooltip` on hover. Wire from the caller as
   *  `!canEditShared && projectIsSynced` so unsynced (local-only) projects
   *  stay editable. */
  disabled?: boolean
  disabledTooltip?: string
}

export function HealthSettingsSection({
  settings, rulePenalties, onChange, onRulePenaltiesChange, onReset,
  disabled = false, disabledTooltip,
}: Props) {
  // Effective config — used for caps + weights. rulePenalties comes from the
  // dedicated prop above so this surface stays in sync with the RulesPage card
  // even when one side hasn't been re-read yet.
  const effective: HealthConfig = resolveHealthConfig({
    healthSettings: settings,
  } as Parameters<typeof resolveHealthConfig>[0])

  function updateCap(key: keyof HealthConfig["caps"], raw: string) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    // No single penalty dimension can subtract more than 100 — beyond that the
    // final score is clamped to 0 anyway. Keep the stored value sane.
    const clamped = Math.max(0, Math.min(100, Math.round(n)))
    const next: HealthSettings = {
      followDefaults: false,
      overrides: {
        ...(settings.overrides ?? {}),
        caps: { ...(settings.overrides?.caps ?? {}), [key]: clamped },
      },
    }
    onChange(next)
  }

  function updateWeight(key: keyof HealthConfig["neighborhoodWeights"], raw: string) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    const next: HealthSettings = {
      followDefaults: false,
      overrides: {
        ...(settings.overrides ?? {}),
        neighborhoodWeights: {
          ...(settings.overrides?.neighborhoodWeights ?? {}),
          [key]: n,
        },
      },
    }
    onChange(next)
  }

  function updateRulePenalty(key: "major" | "minor", raw: string) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    const clamped = Math.max(0, Math.min(100, Math.round(n)))
    onRulePenaltiesChange({ ...rulePenalties, [key]: clamped })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Switch
              aria-label="Follow defaults"
              checked={settings.followDefaults}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ ...settings, followDefaults: Boolean(v) })}
            />
          </DisabledFieldTooltip>
          <span className="text-sm font-medium">Follow defaults</span>
          <p className="ml-2 text-xs text-muted-foreground">
            {settings.followDefaults
              ? "This project uses the shipped defaults. Edits flip it off."
              : "Custom values are used. Reset to start over."}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CapInput id="cap-validation" label="Validation gap cap" value={effective.caps.validationGap}
            min={0} max={100} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateCap("validationGap", v)} />
          <CapInput id="cap-ancestry" label="Ancestry cap" value={effective.caps.ancestryPenalty}
            min={0} max={100} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateCap("ancestryPenalty", v)} />
          <CapInput id="cap-neighborhood" label="Neighborhood cap" value={effective.caps.neighborhoodPenalty}
            min={0} max={100} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateCap("neighborhoodPenalty", v)} />
          <CapInput id="cap-rules" label="Rules cap" value={effective.caps.rulePenalty}
            min={0} max={100} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateCap("rulePenalty", v)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CapInput id="weight-jaccard" label="ID Jaccard weight" value={effective.neighborhoodWeights.idJaccard}
            step={0.05} min={0} max={1} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateWeight("idJaccard", v)} />
          <CapInput id="weight-tfidf" label="TF-IDF weight" value={effective.neighborhoodWeights.tfidfTokenOverlap}
            step={0.05} min={0} max={1} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateWeight("tfidfTokenOverlap", v)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CapInput id="rp-major" label="Major rule penalty" value={rulePenalties.major}
            min={0} max={100} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateRulePenalty("major", v)} />
          <CapInput id="rp-minor" label="Minor rule penalty" value={rulePenalties.minor}
            min={0} max={100} disabled={disabled} disabledTooltip={disabledTooltip}
            onChange={(v) => updateRulePenalty("minor", v)} />
        </div>

        <div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || !settings.overrides || Object.keys(settings.overrides).length === 0}
            onClick={() => {
              if (confirm("Reset all health overrides to defaults? This can't be undone.")) onReset()
            }}
          >
            Reset overrides
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Defaults come from <code>HEALTH_DEFAULTS</code> in <code>src/lib/health/defaults.ts</code>.
          Caps are subtracted from 100 — see the design spec for formulas.
          {!settings.followDefaults && (
            <>
              <br />
              <em>This project will no longer auto-follow default changes.</em>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  )
}

function CapInput({
  id, label, value, step = 1, min, max, disabled = false, disabledTooltip, onChange,
}: {
  id: string; label: string; value: number; step?: number; min?: number; max?: number;
  disabled?: boolean; disabledTooltip?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
        <Input
          id={id} type="number" step={step} min={min} max={max}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </DisabledFieldTooltip>
    </div>
  )
}
