import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio } from "@/lib/frontier/portfolio"
import { getMyAssignments, type MyAssignment } from "@/lib/sync/assignments"

/**
 * The assignee's "Assigned to me" inbox — the caller's open assignments across
 * the active org. The inbox read is project-scoped server-side, so we fan out:
 * list the org's projects, then fetch /assignments/mine for each (allSettled so
 * a project the caller can't read — 403 — is simply skipped), and flatten.
 * Newest first.
 */
export function AssignedToMe() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [rows, setRows] = useState<MyAssignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const projects = await getPortfolio(jwt, activeOrgId)
        const settled = await Promise.allSettled(projects.map((p) => getMyAssignments(jwt, p.id)))
        const all = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        all.sort((a, b) => b.createdAt - a.createdAt)
        if (!cancelled) setRows(all)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Assigned to me" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto space-y-4 p-6">
          <h1 className="text-lg font-semibold">Assigned to me</h1>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">You have no open assignments.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {rows.map((a) => {
                const pct = a.cellsTotal > 0 ? Math.round((a.cellsDone / a.cellsTotal) * 100) : 0
                return (
                  <Link
                    key={a.assignmentId}
                    to={`/project/${a.projectId}`}
                    className="block p-4 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{a.scopeLabel}</p>
                      {a.deadline && (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Due {a.deadline}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {a.cellsDone}/{a.cellsTotal} cells · {pct}%
                    </p>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      }
    />
  )
}
