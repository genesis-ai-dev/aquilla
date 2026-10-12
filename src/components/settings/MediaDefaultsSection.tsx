// AQU-1768: org-level defaults for the timeline and recording settings —
// the timing lock, timeline track editing, who may add and remove lines,
// validating your own recordings, and the minimum role to validate a
// recording. Projects follow these unless they set their own in Project
// settings; the server's gates resolve the same way.
//
// Same shape and MAINTAINER gate as ValidationDefaultsSection beside it, and
// the same follow-up question after a change: projects with their own value
// will not move, so ask whether to put them back on the default. Each row's
// label is the project page's own string, so a translator sees it once and
// both pages name the setting identically.
//
// An org that never set one shows the built-in default (locked, off, nobody,
// allowed, reviewer); picking a value stores it as the org's choice.

import { useState, type ReactNode } from "react"
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
import { Switch } from "@/components/ui/switch"
import { CELL_EDITING_FLOOR_OPTIONS, cellEditingTierLabel } from "@/components/ProjectSettings/cell-editing-floor-options"
import { resolveRoleName, VALIDATION_FLOOR_ROLE_OPTIONS } from "@/lib/frontier/roles"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"
import type { OrgWideSettings } from "@/lib/sync/org-settings"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { MediaDefaultKey } from "../../../db/shared/media-setting-defaults"

interface MediaDefaultsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the MAINTAINER write gate. */
  canEdit: boolean
}

/** What each setting reads as when neither the org nor a project sets it. */
const BUILT_IN = {
  timingLocked: true,
  allowTrackEditing: false,
  cellEditingFloor: "none",
  allowSelfValidationAudio: true,
  validationRoleFloorAudio: "reviewer",
} as const

export function MediaDefaultsSection({ orgSettings, canEdit }: MediaDefaultsSectionProps) {
  const { t } = useI18n()
  const defaults = orgSettings.mediaDefaults
  const roleItems = VALIDATION_FLOOR_ROLE_OPTIONS.map((o) => ({ value: o.name, label: resolveRoleName(t, o.name) }))
  const tierItems = CELL_EDITING_FLOOR_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))

  const booleanRow = (key: "timingLocked" | "allowTrackEditing" | "allowSelfValidationAudio", labelKey: MessageKey, descriptionKey: MessageKey) => (
    <MediaDefaultRow
      key={key}
      orgSettings={orgSettings}
      canEdit={canEdit}
      settingKey={key}
      label={t(labelKey)}
      description={t(descriptionKey)}
      renderControl={({ id, busy, save }) => (
        <Switch
          id={id}
          checked={defaults[key] ?? BUILT_IN[key]}
          onCheckedChange={(checked) => void save(checked)}
          disabled={!canEdit || busy}
          aria-label={t(labelKey)}
        />
      )}
    />
  )

  const selectRow = (
    key: "cellEditingFloor" | "validationRoleFloorAudio",
    labelKey: MessageKey,
    descriptionKey: MessageKey,
    items: Array<{ value: string; label: string }>,
    triggerLabel: (value: string) => string,
  ) => {
    const value = defaults[key] ?? BUILT_IN[key]
    return (
      <MediaDefaultRow
        key={key}
        orgSettings={orgSettings}
        canEdit={canEdit}
        settingKey={key}
        label={t(labelKey)}
        description={t(descriptionKey)}
        renderControl={({ id, busy, save }) => (
          <Select
            items={items.map((o) => ({ value: o.value, label: triggerLabel(o.value) }))}
            disabled={!canEdit || busy}
            value={value}
            onValueChange={(v) => { if (v && v !== value) void save(v) }}
          >
            <SelectTrigger id={id} className="w-48 bg-background" aria-label={t(labelKey)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {items.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      />
    )
  }

  return (
    <>
      {booleanRow("timingLocked", "projectSettings.timeline.lockLabel", "settings.mediaDefaults.timingLockedDescription")}
      {booleanRow("allowTrackEditing", "projectSettings.timeline.trackEditingLabel", "settings.mediaDefaults.allowTrackEditingDescription")}
      {selectRow(
        "cellEditingFloor",
        "projectSettings.cellEditing.label",
        "settings.mediaDefaults.cellEditingFloorDescription",
        tierItems,
        (v) => cellEditingTierLabel(t, v as (typeof BUILT_IN)["cellEditingFloor"]),
      )}
      {booleanRow("allowSelfValidationAudio", "projectSettings.validation.allowSelfAudioLabel", "settings.mediaDefaults.allowSelfValidationAudioDescription")}
      {selectRow(
        "validationRoleFloorAudio",
        "projectSettings.validation.minRoleAudioLabel",
        "settings.mediaDefaults.validationRoleFloorAudioDescription",
        roleItems,
        (v) => roleItems.find((o) => o.value === v)?.label ?? v,
      )}
    </>
  )
}

function MediaDefaultRow({
  orgSettings, canEdit, settingKey, label, description, renderControl,
}: MediaDefaultsSectionProps & {
  settingKey: MediaDefaultKey
  label: string
  description: string
  renderControl: (ctx: { id: string; busy: boolean; save: (next: unknown) => Promise<void> }) => ReactNode
}) {
  const { t } = useI18n()
  const { patch, resetMediaDefaultOverrides } = orgSettings
  const overrides = orgSettings.mediaDefaultOverrides[settingKey] ?? 0
  const id = `org-media-default-${settingKey}`

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingOverrides, setPendingOverrides] = useState<number | null>(null)

  async function save(next: unknown) {
    // Read the count BEFORE the write, as the sections beside this do: the
    // save refreshes the settings and this number with them.
    const overriding = overrides
    setBusy(true)
    setError(null)
    const result = await patch({ [settingKey]: next } as OrgWideSettings)
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
    const result = await resetMediaDefaultOverrides(settingKey)
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
              kind="setting"
              onReset={canEdit ? () => setPendingOverrides(overrides) : undefined}
              disabled={busy}
            />
          </>
        }
        control={
          <div className="flex min-w-44 flex-col items-end gap-1" data-testid={id}>
            {renderControl({ id, busy, save })}
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
