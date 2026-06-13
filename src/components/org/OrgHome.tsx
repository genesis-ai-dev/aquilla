import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio, translatedPct, validatedPct, attentionRank, audioPct, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { listMyPendingInvites, type MyPendingInvite } from "@/lib/sync/invites"
import { WorkloadRollup } from "./WorkloadRollup"
import { UsageRollup } from "./UsageRollup"
import { CreditsPanel } from "./CreditsPanel"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"

const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000

type ActivityStatus = "not-started" | "stalled" | "active"

type StatusFilter = "all" | "active" | "stalled" | "overdue"

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "stalled", label: "Stalled" },
  { value: "overdue", label: "Overdue" },
]

/**
 * A project that has never been edited and has no translated cells hasn't
 * stalled — it just hasn't started yet. "Stalled" is reserved for projects
 * that had activity and then went quiet for 14+ days.
 */
export function activityStatus(p: PortfolioProject, now: number): ActivityStatus {
  if (p.lastEditAt == null && p.filledCells === 0) return "not-started"
  if (p.lastEditAt == null || now - p.lastEditAt > STALE_THRESHOLD_MS) return "stalled"
  return "active"
}

export function OrgHome() {
  const { activeOrg, activeOrgId, orgs, isLoading: orgLoading } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [projects, setProjects] = useState<PortfolioProject[]>([])
  // FRO-335: projects shared from orgs the caller isn't a member of
  // (invite-link / bulk-add grants) — the org portfolio above can't see them.
  const [sharedProjects, setSharedProjects] = useState<CloudProjectSummary[]>([])
  // FRO-326: unredeemed invites addressed to the caller's email — without
  // this card, an invite whose link never arrived is undiscoverable in-app.
  const [pendingInvites, setPendingInvites] = useState<MyPendingInvite[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

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
        if (!cancelled) {
          if (err instanceof UserError && err.category === "session-expired") {
            notifySessionExpired()
          }
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  // FRO-335: surface cross-org grants on the Overview too — otherwise a user
  // whose only project arrived via an invite link sees an empty dashboard.
  useEffect(() => {
    if (!jwt || orgLoading) return
    let cancelled = false
    fetchAccessibleProjects(jwt)
      .then((all) => {
        if (cancelled) return
        setSharedProjects(partitionSharedProjects(all, orgs, activeOrgId).sharedWithMe)
      })
      .catch(() => { if (!cancelled) setSharedProjects([]) })
    return () => { cancelled = true }
  }, [jwt, orgs, activeOrgId, orgLoading])

  // FRO-326: received-invites surface. Org-independent (matched by email).
  useEffect(() => {
    if (!jwt) { setPendingInvites([]); return }
    let cancelled = false
    listMyPendingInvites(jwt)
      .then((list) => { if (!cancelled) setPendingInvites(list) })
      .catch(() => { if (!cancelled) setPendingInvites([]) })
    return () => { cancelled = true }
  }, [jwt])

  // Signed-out state: session finished loading but no JWT.
  // Never show zero-stat fake-empty cards for unauthenticated visitors.
  if (!sessionLoading && !jwt) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={<OrgBreadcrumb section="Overview" />}
        statusBar={null}
        main={
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">Sign in to see your workspace</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Your session has ended or you are not signed in. Sign in to access your projects and translation data.
            </p>
            <Link
              to={`/login?next=${encodeURIComponent("/")}`}
              className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Sign in
            </Link>
          </div>
        }
      />
    )
  }

  const isPageLoading = sessionLoading || orgLoading || loading

  // Rollup stats
  const now = Date.now()
  const avgTranslatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + translatedPct(p), 0) / projects.length
      : 0
  const avgValidatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + validatedPct(p), 0) / projects.length
      : 0
  const stalledCount = projects.filter((p) => activityStatus(p, now) === "stalled").length
  const overdueCount = projects.filter((p) => deadlineStatus(p, now) === "overdue").length
  const avgAudioPct =
    projects.length > 0 ? projects.reduce((sum, p) => sum + audioPct(p), 0) / projects.length : 0

  // Attention-ranked list
  const ranked = [...projects].sort((a, b) => attentionRank(b, now) - attentionRank(a, now))

  // Filter bar — narrows the listed projects only; the rollup strip above
  // continues to reflect the full portfolio.
  const visible = ranked.filter((p) => {
    if (query && !p.name.toLowerCase().includes(query.toLowerCase())) return false
    switch (statusFilter) {
      case "active":
        return activityStatus(p, now) === "active"
      case "stalled":
        return activityStatus(p, now) === "stalled"
      case "overdue":
        return deadlineStatus(p, now) === "overdue"
      default:
        return true
    }
  })

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Overview" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6 space-y-6">
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

              {/* FRO-326: received invites — the user has been invited but
                  hasn't accepted yet. Without this, an invite whose email/link
                  never arrived is undiscoverable in-app. */}
              {pendingInvites.length > 0 && (
                <section data-testid="pending-invitations" className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">Pending invitations</h2>
                  <div className="rounded-lg border divide-y">
                    {pendingInvites.map((inv) => (
                      <div key={inv.token} className="flex flex-wrap items-center gap-3 p-4">
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium">
                            {inv.projects.map((p) => p.projectName).join(", ")}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Invited by {inv.createdBy} as {inv.role.name.replace(/_/g, " ")}
                            {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ""}
                          </p>
                        </div>
                        <Link
                          to={`/join/${inv.token}`}
                          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          Review &amp; accept
                        </Link>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Rollup strip */}
              <div className="grid grid-cols-6 gap-4">
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{projects.length}</p>
                  <p className="text-sm text-muted-foreground">Projects</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{Math.round(avgTranslatedPct * 100)}%</p>
                  <p className="text-sm text-muted-foreground">Avg translated</p>
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

              {/* Filter bar */}
              {projects.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter projects…"
                    aria-label="Filter projects by name"
                    className="h-9 w-56 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <div className="flex items-center gap-1">
                    {STATUS_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        onClick={() => setStatusFilter(f.value)}
                        aria-pressed={statusFilter === f.value}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          statusFilter === f.value
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/70"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Attention-ranked list */}
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects in this org yet.</p>
              ) : visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">No matching projects.</p>
              ) : (
                <div className="rounded-lg border divide-y">
                  {visible.map((p) => {
                    const tpct = Math.round(translatedPct(p) * 100)
                    const pct = Math.round(validatedPct(p) * 100)
                    const apct = Math.round(audioPct(p) * 100)
                    const status = activityStatus(p, now)
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
                          <div
                            className="mt-1 space-y-0.5"
                            aria-label={`${tpct}% translated, ${pct}% validated`}
                          >
                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-amber-500" style={{ width: `${tpct}%` }} />
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={`text-xs ${status === "stalled" ? "text-destructive" : "text-muted-foreground"}`}>
                            {status === "stalled"
                              ? "Stalled"
                              : status === "not-started"
                                ? "Not started"
                                : `${tpct}% translated`}
                          </p>
                          <p className="text-xs text-muted-foreground">{pct}% validated</p>
                          <p className="text-xs text-muted-foreground">{apct}% audio</p>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}

              {/* FRO-335: cross-org projects (invite-link / bulk-add grants).
                  Listed separately — they're not part of this org's portfolio,
                  but hiding them made them unreachable from every nav surface. */}
              {sharedProjects.length > 0 && (
                <section data-testid="shared-with-you" className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">Shared with you</h2>
                  <div className="rounded-lg border divide-y">
                    {sharedProjects.map((p) => (
                      <Link
                        key={p.id}
                        to={`/projects/${p.id}`}
                        className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                      >
                        <p className="flex-1 min-w-0 truncate font-medium">{p.name}</p>
                        <span className="shrink-0 text-xs text-muted-foreground">{p.role.name}</span>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {jwt && activeOrgId != null && <WorkloadRollup jwt={jwt} orgId={activeOrgId} />}
              {jwt && activeOrgId != null && <UsageRollup jwt={jwt} orgId={activeOrgId} />}
              {jwt && activeOrgId != null && (
                <CreditsPanel
                  jwt={jwt}
                  orgId={activeOrgId}
                  orgRoleLevel={activeOrg?.role.level ?? 0}
                />
              )}
            </>
          )}
        </div>
      }
    />
  )
}
