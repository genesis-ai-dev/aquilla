import { AssignmentAuthoritySection } from "@/components/settings/AssignmentAuthoritySection"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings, canEditAssignmentAuthority } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsAssignment() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const canEdit = canEditAssignmentAuthority(activeOrg?.role?.level)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.assignment}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.assignment}
    >
      <AssignmentAuthoritySection orgSettings={orgSettings} canEdit={canEdit} />
    </OrgSettingsDetailPage>
  )
}
