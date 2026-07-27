import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Page, PageHeader, Section } from "@/components/ui/page"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { LoadingTemplate } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAdminElevation } from "@/hooks/useAdminElevation"
import { orgHomePath } from "@/lib/navigation/org-paths"
import {
  getAdminOverview,
  getAdminOrgs,
  getAdminTeams,
  getAdminUsers,
  getAdminProjects,
  getAdminActivity,
  getAdminAdmins,
  type AdminOverview,
  type AdminOrg,
  type AdminTeam,
  type AdminUser,
  type AdminProject,
  type AdminActivity,
  type AdminAdmin,
} from "@/lib/frontier/admin"
import { projectsNeedingAttention } from "@/lib/admin/insights"
import { AdminOverviewHome } from "@/components/admin/AdminOverviewHome"
import { AdminTenantsSection } from "@/components/admin/AdminTenantsSection"
import { AdminPeopleSection } from "@/components/admin/AdminPeopleSection"
import { AdminProjectsSection } from "@/components/admin/AdminProjectsSection"
import { AdminActivityTimeline } from "@/components/admin/AdminActivityTimeline"
import { AdminPlatformSection } from "@/components/admin/AdminPlatformSection"
import { AdminElevationGate } from "@/components/admin/AdminElevationGate"

type Tab = "overview" | "tenants" | "people" | "projects" | "activity" | "platform"
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "tenants", label: "Tenants" },
  { key: "people", label: "People" },
  { key: "projects", label: "Projects" },
  { key: "activity", label: "Activity" },
  { key: "platform", label: "Platform" },
]

/**
 * Site-wide admin console (/admin). Cross-tenant: read-only oversight
 * (Overview, Tenants, People, Projects, Activity) plus the editable Platform
 * tab (global AI settings + per-org credits). Gated by `useAdminElevation` —
 * UX only; every /api/v2/admin/* call is enforced server-side against the
 * ADMIN_EMAILS allowlist behind the step-up elevation gate. A non-admin who
 * forces the route is redirected to their org overview.
 */
export function AdminConsole() {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const {
    isAdmin,
    loading: adminLoading,
    email: adminEmail,
    isElevated,
    refresh: refreshElevation,
  } = useAdminElevation()
  const { setActiveOrg } = useActiveOrg()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>("overview")

  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [orgs, setOrgs] = useState<AdminOrg[]>([])
  const [teams, setTeams] = useState<AdminTeam[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [projects, setProjects] = useState<AdminProject[]>([])
  const [activity, setActivity] = useState<AdminActivity[]>([])
  const [admins, setAdmins] = useState<AdminAdmin[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  // Platform admins resolve owner-level on every org/project server-side, and
  // GET /orgs returns every org for them — so switching into a foreign org here
  // lands on a fully navigable org overview.
  const openOrg = useCallback(
    (orgId: number) => {
      setActiveOrg(orgId)
      navigate(orgHomePath(orgId))
    },
    [setActiveOrg, navigate],
  )

  // See useOrg.ts for the StrictMode aliveRef rationale.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    // Don't fetch console data until elevated — every admin call would 403.
    if (!jwt || !isAdmin || !isElevated) return
    if (aliveRef.current) {
      setLoading(true)
      setError(null)
    }
    try {
      const [ov, og, tm, us, pr, ac, ad] = await Promise.all([
        getAdminOverview(jwt),
        getAdminOrgs(jwt),
        getAdminTeams(jwt),
        getAdminUsers(jwt),
        getAdminProjects(jwt),
        getAdminActivity(jwt, 200),
        getAdminAdmins(jwt),
      ])
      if (aliveRef.current) {
        setOverview(ov)
        setOrgs(og)
        setTeams(tm)
        setUsers(us)
        setProjects(pr)
        setActivity(ac)
        setAdmins(ad)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, isAdmin, isElevated])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const atRiskCount = useMemo(() => projectsNeedingAttention(projects, Date.now()).length, [projects])

  // Non-admins have no business here — send them back to their overview.
  // (Server still enforces the ADMIN_EMAILS allowlist on every fetch.)
  if (!adminLoading && !isAdmin) {
    return <Navigate to="/" replace />
  }

  let body: React.ReactNode
  if (adminLoading) {
    body = <p className="text-sm text-muted-foreground">Checking access…</p>
  } else if (!isElevated && jwt) {
    // Hardened console: require a fresh email step-up code before anything loads.
    body = <AdminElevationGate jwt={jwt} email={adminEmail} onElevated={refreshElevation} />
  } else if (loading && overview == null) {
    body = <ConsoleSkeleton />
  } else if (error) {
    body = <p className="text-sm text-destructive">{error}</p>
  } else {
    body = (
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              attentionDot={t.key === "projects" && atRiskCount > 0 ? "amber" : undefined}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="mt-6">
          <TabsContent value="overview">
            {overview && (
              <AdminOverviewHome
                overview={overview}
                orgs={orgs}
                users={users}
                projects={projects}
                activity={activity}
                onOpenOrg={openOrg}
                onViewProjects={() => setTab("projects")}
                onViewActivity={() => setTab("activity")}
              />
            )}
          </TabsContent>

          <TabsContent value="tenants">
            <AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={openOrg} />
          </TabsContent>

          <TabsContent value="people">
            <AdminPeopleSection users={users} admins={admins} />
          </TabsContent>

          <TabsContent value="projects">
            <AdminProjectsSection projects={projects} />
          </TabsContent>

          <TabsContent value="activity">
            <Section title="Activity" description="Cross-tenant events, most recent first.">
              <AdminActivityTimeline activity={activity} />
            </Section>
          </TabsContent>

          <TabsContent value="platform">{jwt && <AdminPlatformSection jwt={jwt} />}</TabsContent>
        </div>
      </Tabs>
    )
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Admin" />}
      statusBar={null}
      main={
        <Page size="wide">
          <PageHeader
            title="Admin console"
            description="Site-wide, cross-tenant view. Oversight is read-only; the Platform tab is editable."
          />
          {body}
        </Page>
      }
    />
  )
}

/** Skeleton mirroring the Overview home while the first fetch is in flight. */
function ConsoleSkeleton() {
  return (
    <LoadingTemplate
      label="Loading admin console"
      className="min-h-[34rem]"
      templateClassName="min-h-[34rem]"
    >
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-72 rounded-full" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl border bg-card" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-2xl border bg-card" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-40 rounded-2xl border bg-card" />
          <Skeleton className="h-40 rounded-2xl border bg-card" />
        </div>
      </div>
    </LoadingTemplate>
  )
}
