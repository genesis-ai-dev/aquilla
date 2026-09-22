/**
 * Org rules as a top-level Settings section (AQU-1131).
 *
 * The org rule library used to be reachable only by opening some project's
 * Living Memory → Translation quality pane, which buried an org-wide concern
 * two levels inside a project surface. It now sits beside the org Knowledge
 * Base in Settings, where an org sees it on arrival.
 *
 * Terminology is settled: these are "rules" (not Paratext's "checks", not
 * "standards") — see the ticket.
 */
import { OrgRulesPanel } from "@/components/rules/OrgRulesPanel"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useT } from "@/lib/i18n/I18nProvider"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsRules() {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { orgRules, promotionRequests, canEdit, patch: patchOrgSettings } = useOrgSettings(
    activeOrgId,
    activeOrg?.role?.level,
  )

  return (
    <OrgSettingsDetailPage
      title={t("rules.orgSettings.title")}
      description={t("rules.orgSettings.description")}
    >
      {activeOrgId != null ? (
        <OrgRulesPanel
          orgRules={orgRules}
          canEdit={canEdit}
          patchOrgSettings={patchOrgSettings}
          promotionRequests={promotionRequests}
        />
      ) : null}
    </OrgSettingsDetailPage>
  )
}
