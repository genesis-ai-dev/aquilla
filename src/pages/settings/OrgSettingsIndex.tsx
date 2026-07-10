import { Link } from "react-router-dom"
import { Archive, Building2, Download, EyeOff, KeyRound, UserCheck, Users, UsersRound } from "lucide-react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
import { NavList, NavRow } from "@/components/ui/nav-list"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { ROLE } from "@/lib/frontier/roles"
import { FLOOR_LABEL } from "./constants"
import { OrgSettingsShell } from "./OrgSettingsShell"

export function OrgSettingsIndex() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { exportMinRole, rosterViewMinRole, allowSelfAssignment } = useOrgSettings(
    activeOrgId,
    activeOrg?.role?.level,
  )
  const displayedExportMinRole = exportMinRole ?? ROLE.MAINTAINER

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
      <div className="space-y-6">
        <NavList label="Organization">
          <NavRow to="/settings/identity" icon={Building2} title="Identity" hint={activeOrg?.name ?? "Untitled"} />
          <NavRow to="/settings/export" icon={Download} title="Export permissions" hint={FLOOR_LABEL[displayedExportMinRole] ?? "Maintainer"} />
          <NavRow to="/settings/roster" icon={EyeOff} title="Roster & progress visibility" hint={FLOOR_LABEL[rosterViewMinRole] ?? "Maintainer"} />
          <NavRow
            to="/settings/assignment"
            icon={UserCheck}
            title="Assignment authority"
            hint={allowSelfAssignment ? "Self-assign on" : "Leads only"}
          />
          <NavRow to="/settings/providers" icon={KeyRound} title="AI provider keys" hint="Org keys" />
        </NavList>

        <NavList label="People & Projects">
          <NavRow to="/members" icon={Users} title="Members" hint="Roles & invites" />
          <NavRow to="/teams" icon={UsersRound} title="Teams" hint="Groups" />
          <NavRow to="/projects/archived" icon={Archive} title="Archived projects" hint="Restore" />
        </NavList>
      </div>
    </OrgSettingsShell>
  )
}
