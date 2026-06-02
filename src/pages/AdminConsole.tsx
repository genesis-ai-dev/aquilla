import { useCallback, useEffect, useRef, useState } from "react"
import { Navigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import {
  getAdminOverview,
  getAdminOrgs,
  getAdminTeams,
  getAdminUsers,
  getAdminProjects,
  getAdminActivity,
  type AdminOverview,
  type AdminOrg,
  type AdminTeam,
  type AdminUser,
  type AdminProject,
  type AdminActivity,
} from "@/lib/frontier/admin"

type Tab = "overview" | "orgs" | "teams" | "users" | "projects" | "activity"
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "orgs", label: "Orgs" },
  { key: "teams", label: "Teams" },
  { key: "users", label: "Users" },
  { key: "projects", label: "Projects" },
  { key: "activity", label: "Activity" },
]

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—"
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString()
}

const pct = (num: number, den: number): string => (den > 0 ? `${Math.round((num / den) * 100)}%` : "—")

/** Drop the leading top-group path segment so a team reads relative to its org
 *  (e.g. "bible-project/bp-francais" → "bp-francais"). Names are GitLab
 *  full_paths; the first segment is always the org's own path. */
const relativeTeamPath = (name: string): string => {
  const i = name.indexOf("/")
  return i === -1 ? name : name.slice(i + 1)
}

/** Group already-org-sorted teams into per-org sections (preserves order). */
function groupByOrg(
  teams: AdminTeam[],
): Array<{ orgId: number; orgName: string | null; teams: AdminTeam[] }> {
  const groups: Array<{ orgId: number; orgName: string | null; teams: AdminTeam[] }> = []
  for (const t of teams) {
    let g = groups[groups.length - 1]
    if (!g || g.orgId !== t.orgId) {
      g = { orgId: t.orgId, orgName: t.orgName, teams: [] }
      groups.push(g)
    }
    g.teams.push(t)
  }
  return groups
}

/**
 * Site-wide admin console (/admin). Cross-tenant, read-only: orgs, users,
 * projects, and the global activity feed. Gated by `usePlatformAdmin` — but
 * that is UX only; every /api/v2/admin/* call is enforced server-side against
 * the PLATFORM_ADMINS allowlist. A non-admin who forces the route is redirected
 * to their org overview ("/"), and any data fetch would 403 regardless.
 */
export function AdminConsole() {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { isAdmin, loading: adminLoading } = usePlatformAdmin()
  const [tab, setTab] = useState<Tab>("overview")

  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [orgs, setOrgs] = useState<AdminOrg[]>([])
  const [teams, setTeams] = useState<AdminTeam[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [projects, setProjects] = useState<AdminProject[]>([])
  const [activity, setActivity] = useState<AdminActivity[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  // See useOrg.ts for the StrictMode aliveRef rationale.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!jwt || !isAdmin) return
    if (aliveRef.current) {
      setLoading(true)
      setError(null)
    }
    try {
      const [ov, og, tm, us, pr, ac] = await Promise.all([
        getAdminOverview(jwt),
        getAdminOrgs(jwt),
        getAdminTeams(jwt),
        getAdminUsers(jwt),
        getAdminProjects(jwt),
        getAdminActivity(jwt, 200),
      ])
      if (aliveRef.current) {
        setOverview(ov)
        setOrgs(og)
        setTeams(tm)
        setUsers(us)
        setProjects(pr)
        setActivity(ac)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, isAdmin])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Non-admins have no business here — send them back to their overview.
  // (Server still enforces the PLATFORM_ADMINS allowlist on every fetch.)
  if (!adminLoading && !isAdmin) {
    return <Navigate to="/" replace />
  }

  let body: React.ReactNode
  if (adminLoading) {
    body = <p className="text-sm text-muted-foreground">Checking access…</p>
  } else if (loading && overview == null) {
    body = <p className="text-sm text-muted-foreground">Loading…</p>
  } else if (error) {
    body = <p className="text-sm text-destructive">{error}</p>
  } else {
    body = (
      <>
        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.key
                  ? "border-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "overview" && overview && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <Stat label="Orgs" value={overview.orgs} />
              <Stat label="Teams" value={overview.teams} />
              <Stat label="Users" value={overview.users} />
              <Stat label="Active projects" value={overview.activeProjects} />
              <Stat label="Archived" value={overview.archivedProjects} />
              <Stat label="Active users (7d)" value={overview.activeUsers7d} />
            </div>
          )}

          {tab === "orgs" && (
            <Table head={["Org", "Owner", "Members", "Projects", "Created"]}>
              {orgs.map((o) => (
                <tr key={o.id} className="border-t">
                  <Td>{o.name ?? `#${o.id}`}</Td>
                  <Td>{o.ownerUsername ?? "—"}</Td>
                  <Td>{o.memberCount}</Td>
                  <Td>{o.projectCount}</Td>
                  <Td>{fmtDate(o.createdAt)}</Td>
                </tr>
              ))}
            </Table>
          )}

          {tab === "teams" &&
            (teams.length === 0 ? (
              <p className="text-sm text-muted-foreground">No teams yet.</p>
            ) : (
              <div className="space-y-6">
                {groupByOrg(teams).map((g) => (
                  <section key={g.orgId}>
                    <h2 className="mb-2 text-sm font-semibold">
                      {g.orgName ?? `Org #${g.orgId}`}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {g.teams.length} {g.teams.length === 1 ? "team" : "teams"}
                      </span>
                    </h2>
                    <Table head={["Team", "Members", "Projects", "Created"]}>
                      {g.teams.map((t) => (
                        <tr key={t.id} className="border-t">
                          <Td>{relativeTeamPath(t.name)}</Td>
                          <Td>{t.memberCount}</Td>
                          <Td>{t.projectCount}</Td>
                          <Td>{fmtDate(t.createdAt)}</Td>
                        </tr>
                      ))}
                    </Table>
                  </section>
                ))}
              </div>
            ))}

          {tab === "users" && (
            <Table head={["Username", "Email", "Orgs", "Last active", "Joined"]}>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <Td>{u.displayName ? `${u.displayName} (${u.username})` : u.username}</Td>
                  <Td>{u.email}</Td>
                  <Td>{u.orgCount}</Td>
                  <Td>{fmtDate(u.lastActiveAt)}</Td>
                  <Td>{fmtDate(u.createdAt)}</Td>
                </tr>
              ))}
            </Table>
          )}

          {tab === "projects" && (
            <Table head={["Project", "Org", "Creator", "Validated", "Words", "Status"]}>
              {projects.map((p) => (
                <tr key={p.id} className="border-t">
                  <Td>{p.name}</Td>
                  <Td>{p.orgName ?? "—"}</Td>
                  <Td>{p.creatorUsername ?? "—"}</Td>
                  <Td>{pct(p.validatedCells, p.totalCells)}</Td>
                  <Td>{p.wordCount.toLocaleString()}</Td>
                  <Td>{p.archived ? "Archived" : "Active"}</Td>
                </tr>
              ))}
            </Table>
          )}

          {tab === "activity" && (
            <Table head={["When", "User", "Type", "Description"]}>
              {activity.map((a) => (
                <tr key={a.id} className="border-t">
                  <Td>{fmtDate(a.timestamp)}</Td>
                  <Td>{a.username ?? `#${a.userId}`}</Td>
                  <Td>{a.type ?? "—"}</Td>
                  <Td>{a.description ?? "—"}</Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </>
    )
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Admin" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-5xl p-6">
            <h1 className="mb-1 text-xl font-semibold">Admin console</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Site-wide, cross-tenant view. Read-only.
            </p>
            {body}
          </div>
        </div>
      }
    />
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4 text-center">
      <p className="text-2xl font-bold">{value.toLocaleString()}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40 text-left text-xs text-muted-foreground">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-top">{children}</td>
}
