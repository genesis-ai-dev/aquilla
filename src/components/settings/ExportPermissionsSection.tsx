// AQU-253: org-level "who can export deliverables" floor.
// Same OWNER-only write gate as roster/progress/assignment/termbase.

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
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface ExportPermissionsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

export function ExportPermissionsSection({ orgSettings, canEdit }: ExportPermissionsSectionProps) {
  const t = useT()
  const { exportMinRole, patch } = orgSettings
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const displayed = exportMinRole ?? ROLE.MAINTAINER
  const roleOption = (level: number, key: MessageKey) => ({
    level,
    label: t(key, { role: resolveRoleName(t, level), level: String(level) }),
  })
  const roleOptions = [
    roleOption(ROLE.VIEWER, "org.exportSettings.roleOptionViewer"),
    roleOption(ROLE.CONTRIBUTOR, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.PROJECT_LEAD, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.MAINTAINER, "org.exportSettings.roleOptionMaintainer"),
    roleOption(ROLE.OWNER, "org.exportSettings.roleOptionOwner"),
  ]

  async function handleChange(newLevel: number) {
    setBusy(true)
    setError(null)
    const result = await patch({ exportMinRole: newLevel })
    if (result.kind === "error") {
      setError(result.message ?? t("org.exportSettings.saveFailedFallback"))
    } else if (result.kind === "blocked") {
      setError(t("org.exportSettings.ownersOnlyPolicyNote"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("org.exportSettings.whoCanExportLabel")}
      description={t("org.exportSettings.whoCanExportDescription")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Select
            items={roleOptions.map((opt) => ({
              value: String(opt.level),
              label: opt.label,
            }))}
            value={String(displayed)}
            onValueChange={(v) => { if (v) void handleChange(Number(v)) }}
            disabled={!canEdit || busy}
          >
            <SelectTrigger id="export-min-role" aria-label={t("org.exportSettings.whoCanExportLabel")} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {roleOptions.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    {opt.label}
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
