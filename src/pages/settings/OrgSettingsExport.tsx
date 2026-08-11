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
import { ROLE } from "@/lib/frontier/roles"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsExport() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { exportMinRole, patch: patchOrgSettings } = useOrgSettings(activeOrgId, activeOrg?.role?.level)

  const canEditExportFloor = (activeOrg?.role.level ?? 0) >= ROLE.OWNER
  const [exportRoleBusy, setExportRoleBusy] = useState(false)
  const [exportRoleError, setExportRoleError] = useState<string | null>(null)

  const exportRoleOptions = [
    { level: ROLE.VIEWER, label: "Viewer (100) — anyone with project access" },
    { level: ROLE.CONTRIBUTOR, label: "Contributor (400)" },
    { level: ROLE.PROJECT_LEAD, label: "Project lead (500)" },
    { level: ROLE.MAINTAINER, label: "Maintainer (600) — default" },
    { level: ROLE.OWNER, label: "Owner (700) — most restrictive" },
  ]
  const displayedExportMinRole = exportMinRole ?? ROLE.MAINTAINER

  async function handleExportRoleChange(newLevel: number) {
    setExportRoleBusy(true)
    setExportRoleError(null)
    const result = await patchOrgSettings({ exportMinRole: newLevel })
    if (result.kind === "error") {
      setExportRoleError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setExportRoleError("Only org owners can change the export permission policy.")
    }
    setExportRoleBusy(false)
  }

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.export}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.export}
    >
      <SettingsGroup label="Deliverables">
        <SettingsRow
          label="Who can export"
          description="Lower the floor to let translators export their own work; raise it to keep deliverables with leads. Client-side formats (CSV, TSV) operate on already-loaded cells and can't be enforced here."
          block
        >
          <Select
            items={exportRoleOptions.map((opt) => ({ value: String(opt.level), label: opt.label }))}
            value={String(displayedExportMinRole)}
            onValueChange={(v) => { if (v) void handleExportRoleChange(Number(v)) }}
            disabled={!canEditExportFloor || exportRoleBusy}
          >
            <SelectTrigger id="export-min-role" aria-label="Who can export">
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
            <FieldDescription>Only org owners can change the export permission policy.</FieldDescription>
          )}
          {exportRoleError && (
            <FieldError className="text-xs">{exportRoleError}</FieldError>
          )}
        </SettingsRow>
      </SettingsGroup>
    </OrgSettingsDetailPage>
  )
}
