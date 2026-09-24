// AQU-1391: org-level default for repetition auto-propagation — does
// validating a cell fill in the other cells in the file whose source text is
// identical?
//
// Same boolean SettingsRow + Switch shape as StructuralCellsSection beside it,
// and the same write gate: MAINTAINER, not owner-only. This is not a
// permission policy — it decides what a validate gesture does to the
// translator's own file, not who may see or do anything.
//
// Default ON, because a CAT-tool user expects to translate a repeated segment
// once (Trados/memoQ/Matecat all do this). An org that wants every repetition
// typed by hand opts out; a project may still override it either way.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface RepetitionPropagationSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the MAINTAINER write gate. */
  canEdit: boolean
}

export function RepetitionPropagationSection({
  orgSettings,
  canEdit,
}: RepetitionPropagationSectionProps) {
  const { t } = useI18n()
  const { autoPropagateRepetitions, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await patch({ autoPropagateRepetitions: next })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.autoPropagateRepetitions.saveFailed"))
    } else if (result.kind === "blocked") {
      setError(t("settings.autoPropagateRepetitions.blocked"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.autoPropagateRepetitions.label")}
      description={t("settings.autoPropagateRepetitions.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Switch
            id="auto-propagate-repetitions"
            checked={autoPropagateRepetitions}
            onCheckedChange={(checked) => void handleChange(checked)}
            disabled={!canEdit || busy}
            aria-label={t("settings.autoPropagateRepetitions.label")}
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
