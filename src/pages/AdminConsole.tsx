import { useCallback, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAdminElevation } from "@/hooks/useAdminElevation"
import { orgHomePath, orgPath } from "@/lib/navigation/org-paths"
import type { AdminTeam } from "@/lib/frontier/admin"
import type { OverviewTile } from "@/components/admin/AdminOverviewHome"
import type { Lens } from "@/components/admin/AdminProjectsSection"
import { AdminPersonView } from "@/components/admin/AdminPersonView"
import { AdminPlatformSection } from "@/components/admin/AdminPlatformSection"
import { AdminRetentionSection } from "@/components/admin/AdminRetentionSection"
import { AdminMigrationSection } from "@/components/admin/AdminMigrationSection"
import { AdminElevationGate } from "@/components/admin/AdminElevationGate"
import {
  AdminActivityTab,
  AdminInvitesTab,
  AdminOverviewTab,
  AdminPeopleTable,
  AdminProjectsTable,
  AdminTeamsTable,
  AdminTenantDetail,
  AdminTenantsTable,
} from "@/components/admin/AdminDirectoryTabs"

type Tab = "overview" | "retention" | "migration" | "tenants" | "teams" | "people" | "projects" | "activity" | "platform" | "invites"
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "retention", label: "Retention" },
  { key: "migration", label: "Migration" },
  { key: "tenants", label: "Tenants" },
  { key: "teams", label: "Teams" },
  { key: "people", label: "People" },
  { key: "projects", label: "Projects" },
  { key: "activity", label: "Activity" },
  { key: "platform", label: "Platform" },
  { key: "invites", label: "Invites & links" },
]

/**
 * Site-wide admin console (/admin). Cross-tenant: read-only oversight
 * (Overview, Retention, Tenants, Teams, People, Projects, Activity) plus the editable
 * Platform tab (AI settings, AI credits, Field Plan billing). Gated by
 * `useAdminElevation` — UX only; every /api/v2/admin/* call is enforced
 * server-side against the ADMIN_EMAILS allowlist behind the step-up elevation
 * gate. A non-admin who forces the route is redirected to their org overview.
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
  // The tab lives in the URL so a reload or a shared link reopens the same view.
  // Switching tabs drops the deeper keys (sub-tab, billing search) with it.
  const [params, setParams] = useSearchParams()
  const tabParam = params.get("tab")
  const tab: Tab = TABS.some((t) => t.key === tabParam) ? (tabParam as Tab) : "overview"
  const setTab = useCallback(
    (next: Tab) => setParams(next === "overview" ? {} : { tab: next }),
    [setParams],
  )
  // Drill-down state also lives in the URL, so Back and shared links work:
  //   ?tab=tenants&org=<id>   one org      ?tab=people&user=<id>   one person
  //   ?tab=projects&lens=...  Projects with a starting filter
  //   ?tab=people&sort=lastActive  People, most recently active first
  const orgIdParam = Number(params.get("org"))
  const userIdParam = Number(params.get("user"))
  const lensParam = params.get("lens")
  const startLens: Lens =
    lensParam === "needs-attention" || lensParam === "active" || lensParam === "archived"
      ? lensParam
      : "all"
  const startPeopleSort = params.get("sort") === "lastActive" ? "lastActive" : "name"
  const selectOrg = useCallback(
    (orgId: number) => setParams({ tab: "tenants", org: String(orgId) }),
    [setParams],
  )
  const selectUser = useCallback(
    (userId: number) => setParams({ tab: "people", user: String(userId) }),
    [setParams],
  )
  const openTile = useCallback(
    (tile: OverviewTile) => {
      switch (tile) {
        case "orgs":
          return setParams({ tab: "tenants" })
        case "teams":
          return setParams({ tab: "teams" })
        case "users":
          return setParams({ tab: "people" })
        case "activeProjects":
          return setParams({ tab: "projects", lens: "active" })
        case "activeUsers":
          return setParams({ tab: "people", sort: "lastActive" })
        case "needAttention":
          return setParams({ tab: "projects", lens: "needs-attention" })
      }
    },
    [setParams],
  )
  const [selectedInvitesOrgId, setSelectedInvitesOrgId] = useState<number | null>(null)
  // Set once Overview has counted projects that need attention. Other tabs do
  // not prefetch that query.
  const [attentionTotal, setAttentionTotal] = useState<number | null>(null)
  const onAttentionTotal = useCallback((total: number) => setAttentionTotal(total), [])

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

  const openOrgPath = useCallback(
    (orgId: number, subpath: string) => {
      setActiveOrg(orgId)
      navigate(orgPath(orgId, subpath))
    },
    [setActiveOrg, navigate],
  )

  const openTeam = useCallback(
    (team: AdminTeam) => {
      setActiveOrg(team.orgId)
      navigate(orgPath(team.orgId, `/teams/${team.id}`))
    },
    [setActiveOrg, navigate],
  )

  // Non-admins have no business here — send them back to their overview.
  // (Server still enforces the ADMIN_EMAILS allowlist on every fetch.)
  if (!adminLoading && !isAdmin) {
    return <Navigate to="/" replace />
  }

  let body: React.ReactNode = null
  if (adminLoading) {
    body = <p className="text-sm text-muted-foreground">Checking access…</p>
  } else if (!isElevated && jwt) {
    // Hardened console: require a fresh email step-up code before anything loads.
    body = <AdminElevationGate jwt={jwt} email={adminEmail} onElevated={refreshElevation} />
  } else if (jwt) {
    body = (
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              attentionDot={t.key === "projects" && (attentionTotal ?? 0) > 0 ? "amber" : undefined}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="mt-6">
          <TabsContent value="overview">
            <AdminOverviewTab
              jwt={jwt}
              onOpenOrg={selectOrg}
              onOpenTile={openTile}
              onViewProjects={() => setTab("projects")}
              onViewActivity={() => setTab("activity")}
              onAttentionTotal={onAttentionTotal}
            />
          </TabsContent>

          <TabsContent value="retention">
            <AdminRetentionSection jwt={jwt} />
          </TabsContent>
          <TabsContent value="migration">
            <AdminMigrationSection jwt={jwt} />
          </TabsContent>

          <TabsContent value="tenants">
            {orgIdParam > 0 ? (
              <AdminTenantDetail
                key={orgIdParam}
                jwt={jwt}
                orgId={orgIdParam}
                tenantsHref="/admin?tab=tenants"
                onOpenInApp={openOrg}
                onSelectUser={selectUser}
              />
            ) : (
              <AdminTenantsTable
                jwt={jwt}
                onSelectOrg={selectOrg}
                onOpenOrgPath={openOrgPath}
                onOpenInvites={(orgId) => {
                  setSelectedInvitesOrgId(orgId)
                  setTab("invites")
                }}
              />
            )}
          </TabsContent>

          <TabsContent value="teams">
            <AdminTeamsTable jwt={jwt} onOpenTeam={openTeam} />
          </TabsContent>

          <TabsContent value="people">
            {Number.isInteger(userIdParam) && userIdParam > 0 ? (
              <AdminPersonView
                key={userIdParam}
                jwt={jwt}
                userId={userIdParam}
                peopleHref="/admin?tab=people"
                onSelectOrg={selectOrg}
              />
            ) : (
              <AdminPeopleTable
                key={startPeopleSort}
                jwt={jwt}
                onSelectUser={selectUser}
                initialSort={startPeopleSort}
              />
            )}
          </TabsContent>

          <TabsContent value="projects">
            <AdminProjectsTable
              key={startLens}
              jwt={jwt}
              initialLens={startLens}
              onSelectOrg={selectOrg}
            />
          </TabsContent>

          <TabsContent value="activity">
            <AdminActivityTab jwt={jwt} />
          </TabsContent>

          <TabsContent value="platform">
            <AdminPlatformSection jwt={jwt} />
          </TabsContent>

          <TabsContent value="invites">
            <AdminInvitesTab jwt={jwt} initialOrgId={selectedInvitesOrgId ?? undefined} />
          </TabsContent>
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
            inset={false}
          />
          {body}
        </Page>
      }
    />
  )
}
