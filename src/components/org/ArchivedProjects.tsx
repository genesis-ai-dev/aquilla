import { useEffect, useState, useCallback } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchArchivedProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { unarchiveProjectRemote } from "@/lib/sync/archive"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { EmptyState } from "@/components/ui/page"
import { Archive, Building2 } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

export function ArchivedProjects() {
  const t = useT()
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
      setError(res.message ?? t("org.projectOverview.restoreForbidden"))
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={t("org.orgSidebar.archived")} />}
      statusBar={null}
      main={
        // AQU-366: see ProjectsList.tsx for why `h-full overflow-y-auto` is the
        // correct (and only) scroll surface inside AppShell's main slot;
        // `overscroll-contain` prevents wheel/trackpad chaining to an ancestor.
        <div className="h-full overflow-y-auto overscroll-contain p-6 space-y-3" data-testid="archived-projects-scroll">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {activeOrgId == null ? (
            <EmptyState
              icon={Building2}
              title={t("org.teamsList.selectOrgTitle")}
              description={t("org.archivedProjects.selectOrgDescription")}
            />
          ) : loading ? (
            <LoadingPanel label={t("org.archivedProjects.loadingLabel")} className="min-h-80" />
          ) : projects.length === 0 ? (
            <EmptyState
              icon={Archive}
              title={t("org.archivedProjects.emptyTitle")}
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
                    {t("org.projectOverview.restore")}
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
