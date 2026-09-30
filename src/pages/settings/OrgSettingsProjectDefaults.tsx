// AQU-1083: organization values that projects inherit.
//
// Its own page rather than a group on Security, which is where the ticket's
// code survey put the first of these. Every other control on Security decides
// who may SEE or DO something; these decide how a project behaves unless it
// says otherwise, which is a different question and was reading as an odd one
// out. Sam's call, 2026-09-05.
//
// One setting today. The page exists because the category is real, not because
// it is full — a project-level control that offers "use the organization
// default" needs somewhere honest for that default to live.

import { RepetitionPropagationSection } from "@/components/settings/RepetitionPropagationSection"
import { StructuralCellsSection } from "@/components/settings/StructuralCellsSection"
import { SettingsGroup } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsProjectDefaults() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES["project-defaults"]}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS["project-defaults"]}
    >
      {/* Label-less: the page title already says "Project defaults" and a
          group heading repeating it would be noise. The card itself is what
          matters — a bare row floating on the page background is what made
          this control read as page furniture on Security. */}
      <SettingsGroup>
        {/* The hook's own MAINTAINER write gate, not the page-level owner
            gate Security passes down: this is not a permission policy. */}
        <StructuralCellsSection orgSettings={orgSettings} canEdit={orgSettings.canEdit} />
        {/* AQU-1391 — same card, same MAINTAINER gate, same reason: it shapes
            what a project's editor does, not who may reach it. */}
        <RepetitionPropagationSection orgSettings={orgSettings} canEdit={orgSettings.canEdit} />
      </SettingsGroup>
    </OrgSettingsDetailPage>
  )
}
