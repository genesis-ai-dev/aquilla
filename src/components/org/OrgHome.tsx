import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"

export function OrgHome() {
  const { activeOrg, isLoading } = useActiveOrg()
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Overview" />}
      statusBar={null}
      main={
        <div className="p-6">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="rounded-lg border p-6">
              <h1 className="text-lg font-semibold">{activeOrg?.name ?? "Workspace"}</h1>
              <p className="mt-1 text-sm text-muted-foreground">Portfolio insights coming soon.</p>
            </div>
          )}
        </div>
      }
    />
  )
}
