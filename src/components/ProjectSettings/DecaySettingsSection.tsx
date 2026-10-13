import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { Input } from "@/components/ui/input"
import { AppTooltip } from "@/components/ui/tooltip"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import type { DecaySettings } from "@/lib/parsers/types"
import { DECAY_DEFAULTS } from "@/lib/health/decay-engine"
import { useT } from "@/lib/i18n/I18nProvider"

// AD-14 amendment 2026-06-04: default maxHops for the confidence propagation.
const DEFAULT_MAX_HOPS = 4

interface DecaySettingsSectionProps {
  settings?: DecaySettings
  onChange: (next: DecaySettings) => void
  disabled?: boolean
  disabledTooltip?: ReactNode
}

/**
 * AD-14 decay tunables. Exposes `maxHops` (confidence propagation radius) and
 * `decayWarnThreshold`. The retired `endorsementTarget` field is no longer
 * shown — confidence is now derived on read via the example-retrieval graph,
 * not counted from write-time endorsement events (AD-14 amendment 2026-06-04).
 *
 * AQU-1197: the one expand-in-place section in Project Settings, so it carries
 * the same containment rule as the checklist accordion. Closed, it is a card
 * like every other settings card on the page (`bg-card`, not a bare outline on
 * the page background). Open, its body is a tinted surface behind a divider
 * under the summary row, so the expanded content is visibly contained rather
 * than running on into whatever follows it.
 */
export function DecaySettingsSection({
  settings,
  onChange,
  disabled,
  disabledTooltip,
}: DecaySettingsSectionProps) {
  const t = useT()
  const maxHops = settings?.maxHops ?? DEFAULT_MAX_HOPS
  const decayWarnThreshold = settings?.decayWarnThreshold ?? DECAY_DEFAULTS.decayWarnThreshold

  return (
    <details data-slot="settings-disclosure" className="group overflow-hidden rounded-lg border bg-card">
      <AppTooltip content={disabledTooltip} disabled={!disabled}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium group-open:border-b">
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground group-open:rotate-90"
            aria-hidden
          />
          {t("projectSettings.decay.summary")}
        </summary>
      </AppTooltip>
      <div data-slot="settings-disclosure-body" className="space-y-4 bg-muted/30 px-4 py-4">
        <p className="text-xs text-muted-foreground">
          {t("projectSettings.decay.description")}
        </p>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="decay-max-hops">{t("projectSettings.decay.maxHopsLabel")}</FieldLabel>
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
              {t("projectSettings.decay.maxHopsDescription", { defaultValue: DEFAULT_MAX_HOPS })}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="decay-warn">{t("projectSettings.decay.attentionThresholdLabel")}</FieldLabel>
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
              {t("projectSettings.decay.attentionThresholdDescription", { defaultValue: DECAY_DEFAULTS.decayWarnThreshold })}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </div>
    </details>
  )
}
