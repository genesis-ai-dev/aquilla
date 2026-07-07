import { useEffect, useState, useCallback } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchArchivedProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { unarchiveProjectRemote } from "@/lib/sync/archive"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { Archive, Building2 } from "lucide-react"

export function ArchivedProjects() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!jwt || activeOrgId == null) {
      setProjects([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetchArchivedProjects(jwt, activeOrgId)
      .then(setProjects)
      .finally(() => setLoading(false))
  }, [jwt, activeOrgId])

  useEffect(() => {
    load()
  }, [load])

  async function handleRestore(id: string) {
    if (!jwt) return
    setError(null)
    const res = await unarchiveProjectRemote(id, jwt)
    if (res.kind === "restored" || res.kind === "local-only") {
      load()
    } else if (res.kind === "forbidden") {
      setError(res.message ?? "Only owners can restore a project.")
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Archived" />}
      statusBar={null}
      main={
        // FRO-366: see ProjectsList.tsx for why `h-full overflow-y-auto` is the
        // correct (and only) scroll surface inside AppShell's main slot;
        // `overscroll-contain` prevents wheel/trackpad chaining to an ancestor.
        <div className="h-full overflow-y-auto overscroll-contain p-6 space-y-3" data-testid="archived-projects-scroll">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {activeOrgId == null ? (
            <EmptyState
              icon={Building2}
              title="Select an organization"
              description="Archived projects are managed within a single organization."
            />
          ) : loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={Archive}
              title="No archived projects."
            />
          ) : (
            <div className="rounded-lg border divide-y">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-4 p-4">
                  <span className="font-medium">{p.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleRestore(p.id)}
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      }
    />
  )
}
