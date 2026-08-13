import { Link } from "react-router-dom"
import { Archive, Building2, KeyRound, Shield, Workflow } from "lucide-react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
import { NavList, NavRow } from "@/components/ui/nav-list"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { membersPath, orgPath, orgSettingsPath } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { OrgSettingsShell } from "./OrgSettingsShell"

export function OrgSettingsIndex() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { canViewRoster } = useOrgSettings(
    activeOrgId,
    activeOrg?.role?.level,
  )
  if (activeOrgId == null) return null

  return (
    <OrgSettingsShell header={<OrgBreadcrumb section="Settings" />}>
      <PageHeader
        title="Organization settings"
        description={
          <>
            Manage this organization. Personal preferences moved to{" "}
            <Link to="/preferences" className="font-medium text-foreground underline underline-offset-4">
              Preferences
            </Link>
            .
          </>
        }
      />
      <div className="flex flex-col gap-12">
        <NavList label="Organization">
          <NavRow to={orgSettingsPath(activeOrgId, "identity")} icon={Building2} title="Identity" hint={activeOrg?.name ?? "Untitled"} />
          <NavRow to={orgSettingsPath(activeOrgId, "security")} icon={Shield} title="Security" hint="Visibility & permissions" />
          <NavRow to={orgSettingsPath(activeOrgId, "providers")} icon={KeyRound} title="AI provider keys" hint="Org keys" />
          <NavRow to={orgSettingsPath(activeOrgId, "monday")} icon={Workflow} title="Monday.com" hint="Board sync" />
        </NavList>

        <NavList label="People & Projects">
          {canViewRoster && (
            <NavRow to={membersPath(activeOrgId)} icon={NAV_PAGE_ICONS.members} title="Members" hint="Roles & invites" />
          )}
          <NavRow to={orgPath(activeOrgId, "/teams")} icon={NAV_PAGE_ICONS.teams} title="Teams" hint="Groups" />
          <NavRow to={orgPath(activeOrgId, "/archived")} icon={Archive} title="Archived projects" hint="Restore" />
        </NavList>
      </div>
    </OrgSettingsShell>
  )
}
