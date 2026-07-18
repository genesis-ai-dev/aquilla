import { OrgProviderSection } from "@/components/settings/OrgProviderSection"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsProviders() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.providers}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.providers}
    >
      <OrgProviderSection orgSettings={orgSettings} />
    </OrgSettingsDetailPage>
  )
}
