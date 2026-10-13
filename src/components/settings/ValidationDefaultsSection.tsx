// AQU-1771: org-level defaults for how many validators a cell (text) and a
// recorded take (audio) need. Projects follow these unless they set their own
// number in Project settings → Validation.
//
// Same shape and gate as StructuralCellsSection beside it: MAINTAINER, not the
// owner-only permission-policy gate, because these decide how a number is
// calculated rather than who may see or do anything. And the same follow-up
// question after a change: if some projects set their own number, they will
// not move, so ask whether to put them back on the default. The labels and the
// generic error/button strings are the project page's and that section's own
// keys, so a translator sees each English string once.

import { useState } from "react"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { OverrideStatus } from "./OverrideStatus"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

type ThresholdKey = "validationCount" | "validationCountAudio"

interface ValidationDefaultsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the MAINTAINER write gate. */
  canEdit: boolean
}

const COUNTS = Array.from({ length: 15 }, (_, i) => i + 1)

export function ValidationDefaultsSection({ orgSettings, canEdit }: ValidationDefaultsSectionProps) {
  const { t } = useI18n()
  return (
    <>
      <ThresholdDefaultRow
        orgSettings={orgSettings}
        canEdit={canEdit}
        settingKey="validationCount"
        id="org-validation-count"
        label={t("projectSettings.validation.requiredTextLabel")}
        description={t("settings.validationDefaults.textDescription")}
      />
      <ThresholdDefaultRow
        orgSettings={orgSettings}
        canEdit={canEdit}
        settingKey="validationCountAudio"
        id="org-validation-count-audio"
        label={t("projectSettings.validation.requiredAudioLabel")}
        description={t("settings.validationDefaults.audioDescription")}
      />
    </>
  )
}

function ThresholdDefaultRow({
  orgSettings, canEdit, settingKey, id, label, description,
}: ValidationDefaultsSectionProps & {
  settingKey: ThresholdKey
  id: string
  label: string
  description: string
}) {
  const { t } = useI18n()
  const { patch, resetValidationCountOverrides } = orgSettings
  // Until the org's settings load, the number and the override count are
  // fallbacks (1 and 0): don't show them as fact, and don't let a change go
  // through on them (it would skip the "move the projects back?" question).
  const loaded = orgSettings.hasFetched
  const current = (settingKey === "validationCount"
    ? orgSettings.validationCountDefault
    : orgSettings.validationCountAudioDefault) ?? 1
  const overrides = settingKey === "validationCount"
    ? orgSettings.validationCountOverrides
    : orgSettings.validationCountAudioOverrides

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingOverrides, setPendingOverrides] = useState<number | null>(null)

  const items = COUNTS.map((n) => ({ value: String(n), label: String(n) }))

  async function handleChange(next: number) {
    if (next === current) return
    // Read the count BEFORE the write, as StructuralCellsSection does: the
    // save refreshes the settings and this number with them.
    const overriding = overrides
    setBusy(true)
    setError(null)
    const result = await patch({ [settingKey]: next })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.structuralCells.saveFailed"))
    } else if (result.kind === "blocked") {
      setError(t("settings.structuralCells.blocked"))
    }
    setBusy(false)
    if (result.kind === "ok" && overriding > 0) setPendingOverrides(overriding)
  }

  async function handleReset() {
    setBusy(true)
    const result = await resetValidationCountOverrides(settingKey)
    if (!result.ok) setError(result.message ?? t("settings.structuralCells.resetFailed"))
    setBusy(false)
    setPendingOverrides(null)
  }

  return (
    <>
      <SettingsRow
        label={<label htmlFor={id}>{label}</label>}
        description={
          <>
            {description}
            <OverrideStatus
              count={overrides}
              kind="number"
              onReset={canEdit ? () => setPendingOverrides(overrides) : undefined}
              disabled={busy}
              loading={!loaded}
            />
          </>
        }
        control={
          <div className="flex min-w-44 flex-col items-end gap-1">
            <Select
              items={items}
              disabled={!canEdit || busy || !loaded}
              value={String(current)}
              onValueChange={(v) => void handleChange(Number(v ?? current))}
            >
              <SelectTrigger id={id} className="w-24 bg-background" aria-label={label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {items.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
              {t("settings.validationDefaults.resetTitle", { count: pendingOverrides ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.validationDefaults.resetDescription", { count: pendingOverrides ?? 0 })}
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
