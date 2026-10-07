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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  const {
    countStructuralCells, patch,
    countStructuralOverrides, resetCountStructuralOverrides,
  } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Non-null once the switch has been flipped and some project is ignoring it.
  const [pendingOverrides, setPendingOverrides] = useState<number | null>(null)

  async function save(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await patch({ countStructuralCells: next })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.structuralCells.saveFailed"))
    } else if (result.kind === "blocked") {
      setError(t("settings.structuralCells.blocked"))
    }
    setBusy(false)
    return result.kind === "ok"
  }

  async function handleChange(next: boolean) {
    // Read the count BEFORE the write: saving refreshes the settings, and by
    // the time it resolves this number is whatever the server just returned.
    const overriding = countStructuralOverrides
    const saved = await save(next)
    // Only ask when the answer would be "nothing". A project with its own
    // setting is deliberately deaf to this switch, which is correct and also
    // how the switch becomes a change nobody can see — so the ask exists, and
    // exists only when there is somebody it would miss.
    if (saved && overriding > 0) setPendingOverrides(overriding)
  }

  async function handleReset() {
    setBusy(true)
    const result = await resetCountStructuralOverrides()
    if (!result.ok) setError(result.message ?? t("settings.structuralCells.resetFailed"))
    setBusy(false)
    setPendingOverrides(null)
  }

  return (
    <>
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
    {/* The switch has already been saved by the time this opens — the org
        default is not in question. What is being asked is whether the
        projects that opted out should come back to following it. */}
    <AlertDialog
      open={pendingOverrides != null}
      onOpenChange={(open) => { if (!open && !busy) setPendingOverrides(null) }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settings.structuralCells.resetTitle", { count: pendingOverrides ?? 0 })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings.structuralCells.resetDescription", { count: pendingOverrides ?? 0 })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("settings.structuralCells.resetKeep")}
          </AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => void handleReset()}>
            {t("settings.structuralCells.resetConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
