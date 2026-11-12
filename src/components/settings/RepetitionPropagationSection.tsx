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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"
import { OverrideStatus } from "./OverrideStatus"

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
  const {
    autoPropagateRepetitions, patch,
    autoPropagateRepetitionsOverrides, resetAutoPropagateRepetitionsOverrides,
  } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // AQU-2263: non-null once the default changed while some project ignores
  // it, or Reset was clicked — the same question its neighbours ask.
  const [pendingOverrides, setPendingOverrides] = useState<number | null>(null)

  async function handleChange(next: boolean) {
    // Read the count before the write: saving refreshes it.
    const overriding = autoPropagateRepetitionsOverrides
    setBusy(true)
    setError(null)
    const result = await patch({ autoPropagateRepetitions: next })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.autoPropagateRepetitions.saveFailed"))
    } else if (result.kind === "blocked") {
      setError(t("settings.autoPropagateRepetitions.blocked"))
    }
    setBusy(false)
    if (result.kind === "ok" && overriding > 0) setPendingOverrides(overriding)
  }

  async function handleReset() {
    setBusy(true)
    const result = await resetAutoPropagateRepetitionsOverrides()
    if (!result.ok) setError(result.message ?? t("settings.structuralCells.resetFailed"))
    setBusy(false)
    setPendingOverrides(null)
  }

  return (
    <>
      <SettingsRow
        label={t("settings.autoPropagateRepetitions.label")}
        description={
          <>
            {t("settings.autoPropagateRepetitions.description")}
            {/* AQU-2263: "N projects set their own", like every row beside it.
                A listed project's own answer sits on its Validation pane. */}
            <OverrideStatus
              count={autoPropagateRepetitionsOverrides}
              kind="setting"
              onReset={canEdit ? () => setPendingOverrides(autoPropagateRepetitionsOverrides) : undefined}
              disabled={busy}
              loading={!orgSettings.hasFetched}
              projects={orgSettings.overrideProjects?.autoPropagateRepetitions ?? null}
              projectHref={(projectId) => projectSettingsPath(projectId, "validation")}
            />
          </>
        }
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
              {t("settings.mediaDefaults.resetDescription", { count: pendingOverrides ?? 0 })}
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
