import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Archive, BookOpen, Building2, CreditCard, KeyRound, Lock, Shield, SlidersHorizontal, SpellCheck, Table2, Workflow } from "lucide-react"
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
import { canChangeOrgSettingsPage, type OrgSettingsPage } from "./org-settings-access"

export function OrgSettingsIndex() {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { canViewRoster } = useOrgSettings(
    activeOrgId,
    activeOrg?.role?.level,
  )
  if (activeOrgId == null) return null
  // AQU-2260: a page you can open but not change says View only here, in
  // place of its usual hint; the page itself says who can change it.
  const hintFor = (page: OrgSettingsPage, hint: ReactNode): ReactNode =>
    activeOrg != null && !canChangeOrgSettingsPage(page, activeOrg.role?.level) ? (
      <span data-testid={`org-settings-view-only-${page}`} className="inline-flex items-center gap-1">
        <Lock className="size-3.5" aria-hidden="true" />
        {t("settings.locked.viewOnly")}
      </span>
    ) : (
      hint
    )

  return (
    <OrgSettingsShell header={<OrgBreadcrumb section={t("editor.navTitle.organizationSettings")} />}>
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
          <NavRow to={orgSettingsPath(activeOrgId, "identity")} icon={Building2} title={t("settings.orgSettingsIndex.navIdentity")} hint={hintFor("identity", activeOrg?.name ?? "Untitled")} />
          <NavRow to={orgSettingsPath(activeOrgId, "security")} icon={Shield} title={t("settings.orgSettingsIndex.navSecurity")} hint={hintFor("security", "Visibility & permissions")} />
          {/* AQU-688: the hint used to read "Field Plan" for every org, including
              the ones that have never been on it. It names the destination, not a
              plan the org may not hold. */}
          <NavRow to={orgSettingsPath(activeOrgId, "billing")} icon={CreditCard} title={t("billing.settings.billing")} hint="Plan & AI usage" />
          <NavRow to={orgSettingsPath(activeOrgId, "providers")} icon={KeyRound} title={t("onboarding.preferences.section.providerKeys.title")} hint={hintFor("providers", "Org keys")} />
          {/* AQU-1131: rules sit beside the Knowledge Base — both are the
              org-wide context an org should see on arrival, not something
              buried inside one project's Living Memory. */}
          <NavRow
            to={orgSettingsPath(activeOrgId, "rules")}
            icon={SpellCheck}
            title={t("rules.orgSettings.title")}
            hint={hintFor("rules", t("rules.orgSettings.navHint"))}
          />
          <NavRow
            to={orgSettingsPath(activeOrgId, "knowledge")}
            icon={BookOpen}
            title={t("knowledgeBase.title")}
            hint={hintFor("knowledge", t("knowledgeBase.orgDescription"))}
          />
          <NavRow to={orgSettingsPath(activeOrgId, "monday")} icon={Workflow} title="Monday.com" hint={hintFor("monday", "Board sync")} />
          <NavRow
            to={orgSettingsPath(activeOrgId, "airtable")}
            icon={Table2}
            title="Airtable"
            hint={hintFor("airtable", t("settings.airtable.navHint"))}
          />
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
            hint={hintFor("project-defaults", "Inherited by every project")}
          />
          <NavRow to={orgPath(activeOrgId, "/archived")} icon={Archive} title={t("editor.navTitle.archivedProjects")} hint="Restore" />
        </NavList>
      </div>
    </OrgSettingsShell>
  )
}
