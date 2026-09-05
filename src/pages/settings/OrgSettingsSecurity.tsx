import { ExportPermissionsSection } from "@/components/settings/ExportPermissionsSection"
import { AssignmentAuthoritySection } from "@/components/settings/AssignmentAuthoritySection"
import { RosterProgressSection } from "@/components/settings/RosterProgressSection"
import { StructuralCellsSection } from "@/components/settings/StructuralCellsSection"
import { TermbaseEditSection } from "@/components/settings/TermbaseEditSection"
import { SettingsGroup } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"
import { useT } from "@/lib/i18n/I18nProvider"

export function OrgSettingsSecurity() {
  const t = useT()
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
        label={t("org.settingsSecurity.groupLabel")}
        description={t("org.settingsSecurity.groupDescription")}
      >
        <ExportPermissionsSection orgSettings={orgSettings} canEdit={canEdit} />
        <AssignmentAuthoritySection orgSettings={orgSettings} canEdit={canEdit} />
        <TermbaseEditSection orgSettings={orgSettings} canEdit={canEdit} />
        {/* AQU-1083: MAINTAINER gate, not the owner-only `canEdit` the rest of
            this group uses. Every other switch here is a permission policy;
            this one only decides how a percentage is calculated. */}
        <StructuralCellsSection orgSettings={orgSettings} canEdit={orgSettings.canEdit} />
      </SettingsGroup>
    </OrgSettingsDetailPage>
  )
}
