// AQU-1083: org-level "do headings count as translatable content" control.
//
// Same boolean SettingsRow + Switch shape as AssignmentAuthoritySection next
// to it, with one deliberate difference: `canEdit` here is the MAINTAINER
// write gate, not the owner-only one. Every other switch on this page is a
// permission policy — it decides who may see or do something — and those are
// owner-only. This one decides how a number is calculated, which the ticket
// puts with maintainers and owners.
//
// Default ON. Counting headings is what every project does today, so an org
// that never touches this sees nothing move. ETEN and the Chinese Language
// Project are the ones who turn it off; a project may still override it.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface StructuralCellsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the MAINTAINER write gate. */
  canEdit: boolean
}

export function StructuralCellsSection({ orgSettings, canEdit }: StructuralCellsSectionProps) {
  const { t } = useI18n()
  const { countStructuralCells, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await patch({ countStructuralCells: next })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.structuralCells.saveFailed"))
    } else if (result.kind === "blocked") {
      setError(t("settings.structuralCells.blocked"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.structuralCells.label")}
      description={t("settings.structuralCells.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Switch
            id="count-structural-cells"
            checked={countStructuralCells}
            onCheckedChange={(checked) => void handleChange(checked)}
            disabled={!canEdit || busy}
            aria-label={t("settings.structuralCells.label")}
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
