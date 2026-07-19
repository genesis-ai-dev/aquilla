import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ClipboardList, Building2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { AppShell } from "@/components/AppShell"
import { EmptyState } from "@/components/ui/page"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getMyAssignmentsForOrg, type MyOrgAssignment } from "@/lib/sync/assignments"

/**
 * The assignee's "Assigned to me" inbox — the caller's open assignments across
 * the active org, fetched in ONE request (GET /orgs/:orgId/assignments/mine).
 * Previously this fanned out one request per project (N requests, N DB
 * connections); the server now returns all of them in a single query.
 */
export function AssignedToMe() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [rows, setRows] = useState<MyOrgAssignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || activeOrgId == null) {
      setRows([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const all = await getMyAssignmentsForOrg(jwt, activeOrgId)
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
        // AQU-366: see ProjectsList.tsx for why `h-full overflow-y-auto` is the
        // correct (and only) scroll surface inside AppShell's main slot;
        // `overscroll-contain` prevents wheel/trackpad chaining to an ancestor.
        <div className="h-full overflow-y-auto overscroll-contain space-y-4 p-6" data-testid="assigned-to-me-scroll">
          <h1 className="text-lg font-semibold">Assigned to me</h1>
          {activeOrgId == null ? (
            <EmptyState
              icon={Building2}
              title="Select an organization"
              description="Assignments are scoped to a single organization."
            />
          ) : loading ? (
            <LoadingPanel label="Loading assignments" className="min-h-80" />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="You have no open assignments."
            />
          ) : (
            <div className="divide-y rounded-lg border">
              {rows.map((a) => {
                const pct = a.cellsTotal > 0 ? Math.round((a.cellsDone / a.cellsTotal) * 100) : 0
                return (
                  <Link
                    key={a.assignmentId}
                    to={a.targetLang ? `/project/${a.projectId}/editor?lane=${encodeURIComponent(a.targetLang)}` : `/project/${a.projectId}/editor`}
                    className="block p-4 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{a.scopeLabel}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">{a.projectName}</span>
                      {/* AQU-538 (§3.5): lane chip when the assignment is pinned to a lane. */}
                      {a.targetLang && (
                        <Badge variant="outline" className="shrink-0">{a.targetLang}</Badge>
                      )}
                      {a.deadline && (
                        <Badge variant="secondary" className="shrink-0">
                          Due {a.deadline}
                        </Badge>
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
