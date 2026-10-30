// AQU-2304: org-level "who can import files" control.
//
// Third write-gating permission-policy row, built on the same shape as
// LanguageEditSection (languageEditMinRole) — read that file first. The two
// differ in exactly two ways:
//
//   1. Its scope is bringing a NEW source file into a project — the Import
//      dialog's "New source text", the sidebar re-import and the IDML copy
//      repair, all of which emit `file.create`. Importing a TRANSLATION into
//      a file that is already here commits target cells and creates nothing,
//      so it stays at Contributor whatever this says.
//   2. It is enforced in sync-worker rather than auth-worker, because
//      sync-worker owns the event log (import-authority.ts). auth-worker only
//      governs who may SET it, and carries the resolved value on the
//      project's settings response so a member outside the org gates on the
//      org's real floor.
//
// Editable only by org owners (OWNER-only write gate, enforced server-side in
// auth-worker/src/routes/org-settings.ts): taking file imports away from every
// project lead in the org — or handing them back — is not a maintainer's call.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ROLE } from "@/lib/frontier/roles"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface ImportPermissionsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

// The closed-trigger text comes from FLOOR_LABEL (short); labelKey is the
// fuller sentence shown in the open dropdown list, below.
//
// Only two options, as with the language floor: the ask is "stop leads
// reshaping the file inventory", and anything below Project lead would hand
// imports to translators — `file.create`'s own static floor refuses that
// anyway, so offering it would be a control that does nothing.
const IMPORT_ROLE_OPTIONS: { level: number; labelKey: MessageKey }[] = [
  { level: ROLE.PROJECT_LEAD, labelKey: "settings.importPermissions.optionProjectLead" },
  { level: ROLE.MAINTAINER, labelKey: "settings.importPermissions.optionMaintainer" },
]

export function ImportPermissionsSection({ orgSettings, canEdit }: ImportPermissionsSectionProps) {
  const { t } = useI18n()
  const { importMinRole, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(newLevel: number) {
    setBusy(true)
    setError(null)
    const result = await patch({ importMinRole: newLevel })
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError(t("settings.importPermissions.ownerOnlyError"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.importPermissions.label")}
      description={t("settings.importPermissions.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Select
            items={IMPORT_ROLE_OPTIONS.map((opt) => ({
              value: String(opt.level),
              label: FLOOR_LABEL[opt.level] ?? t(opt.labelKey),
            }))}
            value={String(importMinRole)}
            onValueChange={(v) => { if (v) void handleChange(Number(v)) }}
            disabled={!canEdit || busy}
          >
            <SelectTrigger
              id="import-min-role"
              aria-label={t("settings.importPermissions.label")}
              className="w-44"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {IMPORT_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
