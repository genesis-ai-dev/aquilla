import { useState } from "react"
import { FieldDescription, FieldError } from "@/components/ui/field"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsExport() {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { exportMinRole, patch: patchOrgSettings } = useOrgSettings(activeOrgId, activeOrg?.role?.level)

  const canEditExportFloor = (activeOrg?.role.level ?? 0) >= ROLE.OWNER
  const [exportRoleBusy, setExportRoleBusy] = useState(false)
  const [exportRoleError, setExportRoleError] = useState<string | null>(null)

  const roleOption = (level: number, k: MessageKey) => ({
    level,
    label: t(k, { role: resolveRoleName(t, level), level: String(level) }),
  })
  const exportRoleOptions = [
    roleOption(ROLE.VIEWER, "org.exportSettings.roleOptionViewer"),
    roleOption(ROLE.CONTRIBUTOR, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.PROJECT_LEAD, "org.exportSettings.roleOptionPlain"),
    roleOption(ROLE.MAINTAINER, "org.exportSettings.roleOptionMaintainer"),
    roleOption(ROLE.OWNER, "org.exportSettings.roleOptionOwner"),
  ]
  const displayedExportMinRole = exportMinRole ?? ROLE.MAINTAINER

  async function handleExportRoleChange(newLevel: number) {
    setExportRoleBusy(true)
    setExportRoleError(null)
    const result = await patchOrgSettings({ exportMinRole: newLevel })
    if (result.kind === "error") {
      setExportRoleError(result.message ?? t("org.exportSettings.saveFailedFallback"))
    } else if (result.kind === "blocked") {
      setExportRoleError(t("org.exportSettings.ownersOnlyPolicyNote"))
    }
    setExportRoleBusy(false)
  }

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.export}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.export}
    >
      <SettingsGroup label={t("org.exportSettings.deliverablesGroupLabel")}>
        <SettingsRow
          label={t("org.exportSettings.whoCanExportLabel")}
          description={t("org.exportSettings.whoCanExportDescription")}
          block
        >
          <Select
            items={exportRoleOptions.map((opt) => ({ value: String(opt.level), label: opt.label }))}
            value={String(displayedExportMinRole)}
            onValueChange={(v) => { if (v) void handleExportRoleChange(Number(v)) }}
            disabled={!canEditExportFloor || exportRoleBusy}
          >
            <SelectTrigger id="export-min-role" aria-label={t("org.exportSettings.whoCanExportLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {exportRoleOptions.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {!canEditExportFloor && (
            <FieldDescription>{t("org.exportSettings.ownersOnlyPolicyNote")}</FieldDescription>
          )}
          {exportRoleError && (
            <FieldError className="text-xs">{exportRoleError}</FieldError>
          )}
        </SettingsRow>
      </SettingsGroup>
    </OrgSettingsDetailPage>
  )
}
