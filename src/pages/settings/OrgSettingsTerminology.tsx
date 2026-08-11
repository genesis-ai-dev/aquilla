import { TermbaseEditSection } from "@/components/settings/TermbaseEditSection"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings, canEditTermbaseFloor } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsTerminology() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const canEdit = canEditTermbaseFloor(activeOrg?.role?.level)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.terminology}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.terminology}
    >
      <TermbaseEditSection orgSettings={orgSettings} canEdit={canEdit} />
    </OrgSettingsDetailPage>
  )
}
