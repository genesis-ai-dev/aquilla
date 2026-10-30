import { OrgProviderSection } from "@/components/settings/OrgProviderSection"
import { ZeroShotTranscriptionSection } from "@/components/settings/ZeroShotTranscriptionSection"
import { SettingsGroup } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useT } from "@/lib/i18n/I18nProvider"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsProviders() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const t = useT()

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.providers}
      page="providers"
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.providers}
    >
      <OrgProviderSection orgSettings={orgSettings} />
      {/* Omnilingual ASR: which hosted models members may use. */}
      <SettingsGroup label={t("settings.transcription.title")}>
        <ZeroShotTranscriptionSection orgSettings={orgSettings} />
      </SettingsGroup>
    </OrgSettingsDetailPage>
  )
}
