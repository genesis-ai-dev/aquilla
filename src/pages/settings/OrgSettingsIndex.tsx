import { Link } from "react-router-dom"
import { Archive, Building2, CreditCard, KeyRound, Shield, Workflow } from "lucide-react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
import { NavList, NavRow } from "@/components/ui/nav-list"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { membersPath, orgPath, orgSettingsPath } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { OrgSettingsShell } from "./OrgSettingsShell"
import { useT } from "@/lib/i18n/I18nProvider"

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
        title={t("billing.settings.title")}
        description={
          <>
            {t("billing.settings.description")}{" "}
            <Link to="/preferences" className="font-medium text-foreground underline underline-offset-4">
              {t("billing.settings.preferences")}
            </Link>
            .
          </>
        }
      />
      <div className="flex flex-col gap-12">
        <NavList label={t("billing.settings.organization")}>
          <NavRow to={orgSettingsPath(activeOrgId, "identity")} icon={Building2} title={t("billing.settings.identity")} hint={activeOrg?.name ?? "Untitled"} />
          <NavRow to={orgSettingsPath(activeOrgId, "security")} icon={Shield} title={t("billing.settings.security")} hint="Visibility & permissions" />
          <NavRow to={orgSettingsPath(activeOrgId, "billing")} icon={CreditCard} title={t("billing.settings.billing")} hint="Field Plan" />
          <NavRow to={orgSettingsPath(activeOrgId, "providers")} icon={KeyRound} title={t("billing.settings.providers")} hint="Org keys" />
          <NavRow to={orgSettingsPath(activeOrgId, "monday")} icon={Workflow} title="Monday.com" hint="Board sync" />
        </NavList>

        <NavList label={t("billing.settings.peopleProjects")}>
          {canViewRoster && (
            <NavRow to={membersPath(activeOrgId)} icon={NAV_PAGE_ICONS.members} title={t("billing.settings.members")} hint="Roles & invites" />
          )}
          <NavRow to={orgPath(activeOrgId, "/teams")} icon={NAV_PAGE_ICONS.teams} title={t("billing.settings.teams")} hint="Groups" />
          <NavRow to={orgPath(activeOrgId, "/archived")} icon={Archive} title={t("billing.settings.archived")} hint="Restore" />
        </NavList>
      </div>
    </OrgSettingsShell>
  )
}
