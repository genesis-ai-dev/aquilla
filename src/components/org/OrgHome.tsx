import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio, validatedPct, attentionRank, audioPct, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"
import { WorkloadRollup } from "./WorkloadRollup"

const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000

function isStalled(p: PortfolioProject, now: number): boolean {
  return p.lastEditAt == null || now - p.lastEditAt > STALE_THRESHOLD_MS
}

export function OrgHome() {
  const { activeOrg, activeOrgId, isLoading: orgLoading } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [projects, setProjects] = useState<PortfolioProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getPortfolio(jwt, activeOrgId)
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const isPageLoading = orgLoading || loading

  // Rollup stats
  const now = Date.now()
  const avgValidatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + validatedPct(p), 0) / projects.length
      : 0
  const stalledCount = projects.filter((p) => isStalled(p, now)).length
  const overdueCount = projects.filter((p) => deadlineStatus(p, now) === "overdue").length
  const avgAudioPct =
    projects.length > 0 ? projects.reduce((sum, p) => sum + audioPct(p), 0) / projects.length : 0

  // Attention-ranked list
  const ranked = [...projects].sort((a, b) => attentionRank(b, now) - attentionRank(a, now))

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Overview" />}
      statusBar={null}
      main={
        <div className="p-6 space-y-6">
          {isPageLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <>
              {/* Org header */}
              <div className="rounded-lg border p-4">
                <h1 className="text-lg font-semibold">{activeOrg?.name ?? "Workspace"}</h1>
              </div>

              {/* Rollup strip */}
              <div className="grid grid-cols-5 gap-4">
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{projects.length}</p>
                  <p className="text-sm text-muted-foreground">Projects</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{Math.round(avgValidatedPct * 100)}%</p>
                  <p className="text-sm text-muted-foreground">Avg validated</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{Math.round(avgAudioPct * 100)}%</p>
                  <p className="text-sm text-muted-foreground">Avg audio</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{stalledCount}</p>
                  <p className="text-sm text-muted-foreground">Stalled</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className={`text-2xl font-bold ${overdueCount > 0 ? "text-destructive" : ""}`}>{overdueCount}</p>
                  <p className="text-sm text-muted-foreground">Overdue</p>
                </div>
              </div>

              {/* Attention-ranked list */}
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects in this org yet.</p>
              ) : (
                <div className="rounded-lg border divide-y">
                  {ranked.map((p) => {
                    const pct = Math.round(validatedPct(p) * 100)
                    const apct = Math.round(audioPct(p) * 100)
                    const stalled = isStalled(p, now)
                    const dstatus = deadlineStatus(p, now)
                    return (
                      <Link
                        key={p.id}
                        to={`/projects/${p.id}`}
                        className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium truncate">{p.name}</p>
                            {dstatus === "overdue" && (
                              <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                                Overdue
                              </span>
                            )}
                            {dstatus === "soon" && (
                              <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                Due soon
                              </span>
                            )}
                          </div>
                          <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-medium">{pct}%</p>
                          <p className={`text-xs ${stalled ? "text-destructive" : "text-muted-foreground"}`}>
                            {stalled ? "Stalled" : `${pct}% validated`}
                          </p>
                          <p className="text-xs text-muted-foreground">{apct}% audio</p>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}

              {jwt && activeOrgId != null && <WorkloadRollup jwt={jwt} orgId={activeOrgId} />}
            </>
          )}
        </div>
      }
    />
  )
}
