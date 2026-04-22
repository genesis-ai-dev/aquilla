import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import type { HealthSettings, HealthConfig } from "@/lib/parsers/types"
import { resolveHealthConfig } from "@/lib/health/config-resolver"

interface Props {
  settings: HealthSettings
  onChange: (next: HealthSettings) => void
  onReset: () => void
}

export function HealthSettingsSection({ settings, onChange, onReset }: Props) {
  // Effective config — shown in the inputs; writes go into overrides.
  const effective: HealthConfig = resolveHealthConfig({
    healthSettings: settings,
  } as Parameters<typeof resolveHealthConfig>[0])

  function updateCap(key: keyof HealthConfig["caps"], raw: string) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    const next: HealthSettings = {
      followDefaults: false,
      overrides: {
        ...(settings.overrides ?? {}),
        caps: { ...(settings.overrides?.caps ?? {}), [key]: n },
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
    const next: HealthSettings = {
      followDefaults: false,
      overrides: {
        ...(settings.overrides ?? {}),
        rulePenalties: { ...(settings.overrides?.rulePenalties ?? {}), [key]: n },
      },
    }
    onChange(next)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            aria-label="Follow defaults"
            checked={settings.followDefaults}
            onCheckedChange={(v) => onChange({ ...settings, followDefaults: Boolean(v) })}
          />
          <span className="text-sm font-medium">Follow defaults</span>
          <p className="ml-2 text-xs text-muted-foreground">
            {settings.followDefaults
              ? "This project uses the shipped defaults. Edits flip it off."
              : "Custom values are used. Reset to start over."}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CapInput id="cap-validation" label="Validation gap cap" value={effective.caps.validationGap}
            onChange={(v) => updateCap("validationGap", v)} />
          <CapInput id="cap-ancestry" label="Ancestry cap" value={effective.caps.ancestryPenalty}
            onChange={(v) => updateCap("ancestryPenalty", v)} />
          <CapInput id="cap-neighborhood" label="Neighborhood cap" value={effective.caps.neighborhoodPenalty}
            onChange={(v) => updateCap("neighborhoodPenalty", v)} />
          <CapInput id="cap-rules" label="Rules cap" value={effective.caps.rulePenalty}
            onChange={(v) => updateCap("rulePenalty", v)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CapInput id="weight-jaccard" label="ID Jaccard weight" value={effective.neighborhoodWeights.idJaccard}
            step={0.05}
            onChange={(v) => updateWeight("idJaccard", v)} />
          <CapInput id="weight-tfidf" label="TF-IDF weight" value={effective.neighborhoodWeights.tfidfTokenOverlap}
            step={0.05}
            onChange={(v) => updateWeight("tfidfTokenOverlap", v)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CapInput id="rp-major" label="Major rule penalty" value={effective.rulePenalties.major}
            onChange={(v) => updateRulePenalty("major", v)} />
          <CapInput id="rp-minor" label="Minor rule penalty" value={effective.rulePenalties.minor}
            onChange={(v) => updateRulePenalty("minor", v)} />
        </div>

        <div>
          <Button
            type="button"
            variant="outline"
            disabled={!settings.overrides || Object.keys(settings.overrides).length === 0}
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
  id, label, value, step = 1, onChange,
}: { id: string; label: string; value: number; step?: number; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
