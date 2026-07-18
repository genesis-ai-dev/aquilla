import { RosterProgressSection } from "@/components/settings/RosterProgressSection"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsRoster() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const canEdit = canEditRosterProgressFloor(activeOrg?.role?.level)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.roster}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.roster}
    >
      <RosterProgressSection orgSettings={orgSettings} canEdit={canEdit} />
    </OrgSettingsDetailPage>
  )
}
