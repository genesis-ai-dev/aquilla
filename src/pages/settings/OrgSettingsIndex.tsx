import { Link } from "react-router-dom"
import { Archive, BookOpen, Building2, CreditCard, KeyRound, Shield, SlidersHorizontal, Workflow } from "lucide-react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
import { NavList, NavRow } from "@/components/ui/nav-list"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { membersPath, orgPath, orgSettingsPath } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsShell } from "./OrgSettingsShell"

export function OrgSettingsIndex() {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { canViewRoster } = useOrgSettings(
    activeOrgId,
    activeOrg?.role?.level,
  )
  if (activeOrgId == null) return null

  return (
    <OrgSettingsShell header={<OrgBreadcrumb section="Settings" />}>
      <PageHeader
        title={t("editor.navTitle.organizationSettings")}
        description={
          <RichMessage
            k="settings.orgSettingsIndex.description"
            values={{
              link: (
                <Link to="/preferences" className="font-medium text-foreground underline underline-offset-4">
                  {t("nav.account.preferences")}
                </Link>
              ),
            }}
          />
        }
      />
      <div className="flex flex-col gap-12">
        <NavList label={t("onboarding.apiTokens.orgLabel")}>
          <NavRow to={orgSettingsPath(activeOrgId, "identity")} icon={Building2} title={t("settings.orgSettingsIndex.navIdentity")} hint={activeOrg?.name ?? "Untitled"} />
          <NavRow to={orgSettingsPath(activeOrgId, "security")} icon={Shield} title={t("settings.orgSettingsIndex.navSecurity")} hint="Visibility & permissions" />
          <NavRow to={orgSettingsPath(activeOrgId, "billing")} icon={CreditCard} title={t("billing.settings.billing")} hint="Field Plan" />
          <NavRow to={orgSettingsPath(activeOrgId, "providers")} icon={KeyRound} title={t("onboarding.preferences.section.providerKeys.title")} hint="Org keys" />
          <NavRow
            to={orgSettingsPath(activeOrgId, "knowledge")}
            icon={BookOpen}
            title={t("knowledgeBase.title")}
            hint={t("knowledgeBase.orgDescription")}
          />
          <NavRow to={orgSettingsPath(activeOrgId, "monday")} icon={Workflow} title="Monday.com" hint="Board sync" />
        </NavList>

        <NavList label={t("billing.settings.peopleProjects")}>
          {canViewRoster && (
            <NavRow to={membersPath(activeOrgId)} icon={NAV_PAGE_ICONS.members} title={t("editor.navTitle.members")} hint="Roles & invites" />
          )}
          <NavRow to={orgPath(activeOrgId, "/teams")} icon={NAV_PAGE_ICONS.teams} title={t("editor.navTitle.teams")} hint="Groups" />
          {/* AQU-1083: values a project follows unless it sets its own. Here
              rather than on Security, whose every other control is about who
              may see or do something. */}
          <NavRow
            to={orgSettingsPath(activeOrgId, "project-defaults")}
            icon={SlidersHorizontal}
            title={ORG_SETTINGS_SECTION_TITLES["project-defaults"]}
            hint="Inherited by every project"
          />
          <NavRow to={orgPath(activeOrgId, "/archived")} icon={Archive} title={t("editor.navTitle.archivedProjects")} hint="Restore" />
        </NavList>
      </div>
    </OrgSettingsShell>
  )
}
