// AQU-907: org-level "who can use Data egress" floor — the org-wide bulk zip
// surface. OWNER default; same OWNER-only write gate as the other
// permission-policy floors (export/roster/progress/assignment/termbase).

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

interface EgressAccessSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

export function EgressAccessSection({ orgSettings, canEdit }: EgressAccessSectionProps) {
  const t = useT()
  const { egressMinRole, patch } = orgSettings
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roleOption = (level: number, key: MessageKey) => ({
    level,
    label: t(key, { role: resolveRoleName(t, level), level: String(level) }),
  })
  // Reuse the export-permission dropdown's entry shapes; the ends of the
  // ladder swap notes — OWNER is this floor's default, VIEWER its widest.
  const roleOptions = [
    roleOption(ROLE.VIEWER, "org.egressSettings.roleOptionViewer"),
    roleOption(ROLE.CONTRIBUTOR, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.PROJECT_LEAD, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.MAINTAINER, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.OWNER, "org.egressSettings.roleOptionOwner"),
  ]

  async function handleChange(newLevel: number) {
    setBusy(true)
    setError(null)
    const result = await patch({ egressMinRole: newLevel })
    if (result.kind === "error") {
      setError(result.message ?? t("org.egressSettings.saveFailedFallback"))
    } else if (result.kind === "blocked") {
      setError(t("org.egressSettings.ownersOnlyPolicyNote"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("org.egressSettings.whoCanEgressLabel")}
      description={t("org.egressSettings.whoCanEgressDescription")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Select
            items={roleOptions.map((opt) => ({
              value: String(opt.level),
              label: opt.label,
            }))}
            value={String(egressMinRole)}
            onValueChange={(v) => { if (v) void handleChange(Number(v)) }}
            disabled={!canEdit || busy}
          >
            <SelectTrigger id="egress-min-role" aria-label={t("org.egressSettings.whoCanEgressLabel")} className="w-44">
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
