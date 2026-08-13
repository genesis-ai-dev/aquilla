import { ExportPermissionsSection } from "@/components/settings/ExportPermissionsSection"
import { AssignmentAuthoritySection } from "@/components/settings/AssignmentAuthoritySection"
import { RosterProgressSection } from "@/components/settings/RosterProgressSection"
import { TermbaseEditSection } from "@/components/settings/TermbaseEditSection"
import { SettingsGroup } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsSecurity() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const canEdit = canEditRosterProgressFloor(activeOrg?.role?.level)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.security}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.security}
    >
      <RosterProgressSection orgSettings={orgSettings} canEdit={canEdit} />
      <SettingsGroup
        label="Permissions"
        description="Who can export deliverables, claim work, and manage terminology."
      >
        <ExportPermissionsSection orgSettings={orgSettings} canEdit={canEdit} />
        <AssignmentAuthoritySection orgSettings={orgSettings} canEdit={canEdit} />
        <TermbaseEditSection orgSettings={orgSettings} canEdit={canEdit} />
      </SettingsGroup>
    </OrgSettingsDetailPage>
  )
}
