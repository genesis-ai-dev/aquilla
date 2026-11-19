// Sam, question 93: "Mono loudness" in the Export dialog's audio settings —
// "As heard" (the default) or "As a single-channel meter reads it". The
// explanation sits behind a click (i) (InfoToggle / InfoReveal), never a hover.
// What the choice does is export/mono-loudness.ts; playback always plays as heard.

import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MonoLoudness } from "@/lib/export/mono-loudness"

export function MonoLoudnessOption({ value, onChange }: { value: MonoLoudness; onChange(next: MonoLoudness): void }) {
  const t = useT()
  const [open, toggle] = useInfoOpen()
  const labelId = "export-mono-loudness-label"
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="export-mono-loudness">
      <span className="inline-flex items-center gap-1 text-foreground">
        <span id={labelId} className="font-medium">{t("importExport.dialog.monoLoudness")}</span>
        <InfoToggle open={open} onToggle={toggle} label={t("importExport.dialog.monoLoudnessInfoLabel")} controls="export-mono-loudness-info" />
      </span>
      <InfoReveal open={open} id="export-mono-loudness-info" testId="export-mono-loudness-info">
        <span className="block text-muted-foreground">{t("importExport.dialog.monoLoudnessInfo")}</span>
      </InfoReveal>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(v) => onChange(v as MonoLoudness)}
        className="gap-1"
      >
        {(["heard", "meter"] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <RadioGroupItem value={v} data-testid={`export-mono-loudness-${v}`} />
            <span className="text-foreground">
              {v === "heard" ? t("importExport.dialog.monoLoudnessHeard") : t("importExport.dialog.monoLoudnessMeter")}
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  )
}
