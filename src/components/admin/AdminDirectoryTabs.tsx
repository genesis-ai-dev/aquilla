import { useEffect, useState } from "react"
import { Section } from "@/components/ui/page"
import { LoadingTemplate } from "@/components/ui/loading-overlay"
import { LoadingCursor } from "@/components/ui/loading-cursor"
import { AdminOverviewHome, type OverviewTile } from "@/components/admin/AdminOverviewHome"
import { AdminTenantsSection } from "@/components/admin/AdminTenantsSection"
import { AdminTeamsSection } from "@/components/admin/AdminTeamsSection"
import { AdminPeopleSection } from "@/components/admin/AdminPeopleSection"
import { AdminProjectsSection, type Lens } from "@/components/admin/AdminProjectsSection"
import { AdminOrgView } from "@/components/admin/AdminOrgView"
import { AdminActivityTimeline } from "@/components/admin/AdminActivityTimeline"
import { AdminInvitesSection } from "@/components/admin/AdminInvitesSection"
import { useAdminDirectory } from "@/components/admin/useAdminDirectory"
import type { AdminTableServer } from "@/components/admin/admin-directory-ui"
import {
  getAdminActivity,
  getAdminAdmins,
  getAdminOrg,
  getAdminOrgs,
  getAdminOrgsPage,
  getAdminOverview,
  getAdminProjects,
  getAdminProjectsPage,
  getAdminTeamsPage,
  getAdminUsers,
  getAdminUsersPage,
  type AdminActivity,
  type AdminAdmin,
  type AdminOrg,
  type AdminOverview,
  type AdminProject,
  type AdminTeam,
  type AdminUser,
} from "@/lib/frontier/admin"

function asServer<T>(directory: ReturnType<typeof useAdminDirectory<T>>): AdminTableServer {
  return {
    total: directory.total,
    search: directory.search,
    onSearchChange: directory.setSearch,
    searching: directory.searching,
    loading: directory.loading,
    loadingMore: directory.loadingMore,
    hasMore: directory.hasMore,
    onLoadMore: directory.loadMore,
    onSortingChange: directory.setSorting,
  }
}

function DirectoryError({ message }: { message: string | null }) {
  if (!message) return null
  return <p className="text-sm text-destructive">{message}</p>
}

/**
 * Overview loads its own tiles, then the three lists beside them. The heavy
 * needs-attention query runs here, and only here, until someone opens Projects.
 */
export function AdminOverviewTab({
  jwt,
  onOpenOrg,
  onOpenTile,
  onViewProjects,
  onViewActivity,
  onAttentionTotal,
}: {
  jwt: string
  onOpenOrg: (orgId: number) => void
  onOpenTile: (tile: OverviewTile) => void
  onViewProjects: () => void
  onViewActivity: () => void
  onAttentionTotal: (total: number) => void
}) {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [activity, setActivity] = useState<AdminActivity[] | null>(null)
  const [activityError, setActivityError] = useState<string | null>(null)
  const [loadedJwt, setLoadedJwt] = useState(jwt)
  if (loadedJwt !== jwt) {
    setLoadedJwt(jwt)
    setOverview(null)
    setOverviewError(null)
    setActivity(null)
    setActivityError(null)
  }
  const orgs = useAdminDirectory<AdminOrg>({
    load: (query) => getAdminOrgsPage(jwt, { ...query, limit: 5, offset: 0, sort: "projectCount", dir: "desc" }),
    queryKey: `overview-orgs:${jwt}`,
    initialSort: { id: "projectCount", desc: true },
    pageSize: 5,
  })
  const attention = useAdminDirectory<AdminProject>({
    load: (query) => getAdminProjectsPage(jwt, { ...query, lens: "needs-attention" }),
    queryKey: `overview-attention:${jwt}`,
    initialSort: { id: "status", desc: true },
    pageSize: 6,
  })

  useEffect(() => {
    let alive = true
    getAdminOverview(jwt)
      .then((row) => {
        if (alive) setOverview(row)
      })
      .catch((err: unknown) => {
        if (alive) setOverviewError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [jwt])

  useEffect(() => {
    let alive = true
    getAdminActivity(jwt, 8)
      .then((rows) => {
        if (alive) setActivity(rows)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setActivity([])
        setActivityError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [jwt])

  useEffect(() => {
    if (attention.loading || attention.error) return
    onAttentionTotal(attention.total)
  }, [attention.loading, attention.error, attention.total, onAttentionTotal])

  if (overviewError) return <DirectoryError message={overviewError} />
  if (!overview) {
    return (
      <LoadingTemplate label="Loading admin console" className="min-h-[34rem]" templateClassName="min-h-[34rem]">
        <LoadingCursor className="text-xl" />
      </LoadingTemplate>
    )
  }

  return (
    <AdminOverviewHome
      overview={overview}
      orgs={orgs.rows}
      users={[]}
      projects={attention.rows}
      activity={activity ?? []}
      onOpenOrg={onOpenOrg}
      onOpenTile={onOpenTile}
      onViewProjects={onViewProjects}
      onViewActivity={onViewActivity}
      attentionTotal={attention.loading ? undefined : attention.total}
      overdueTotal={attention.loading || attention.overdue == null ? undefined : attention.overdue}
      attentionLoading={attention.loading}
      orgsLoading={orgs.loading}
      activityLoading={activity == null && activityError == null}
      attentionError={attention.error}
      orgsError={orgs.error}
      activityError={activityError}
    />
  )
}

export function AdminTenantsTable({
  jwt,
  onSelectOrg,
  onOpenOrgPath,
  onOpenInvites,
}: {
  jwt: string
  onSelectOrg: (orgId: number) => void
  onOpenOrgPath: (orgId: number, subpath: string) => void
  onOpenInvites: (orgId: number) => void
}) {
  const directory = useAdminDirectory<AdminOrg>({
    load: (query) => getAdminOrgsPage(jwt, query),
    queryKey: `tenants:${jwt}`,
    initialSort: { id: "organization", desc: false },
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DirectoryError message={directory.error} />
      <AdminTenantsSection
        orgs={directory.rows}
        teams={[]}
        onSelectOrg={onSelectOrg}
        onOpenOrgPath={onOpenOrgPath}
        onOpenInvites={onOpenInvites}
        server={asServer(directory)}
        fill
      />
    </div>
  )
}

export function AdminTenantDetail({
  jwt,
  orgId,
  tenantsHref,
  onOpenInApp,
  onSelectUser,
}: {
  jwt: string
  orgId: number
  tenantsHref: string
  onOpenInApp: (orgId: number) => void
  onSelectUser: (userId: number) => void
}) {
  const [org, setOrg] = useState<AdminOrg | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestKey = `${jwt}:${orgId}`
  const [loadedKey, setLoadedKey] = useState(requestKey)
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey)
    setOrg(null)
    setError(null)
  }
  useEffect(() => {
    let alive = true
    getAdminOrg(jwt, orgId)
      .then((row) => {
        if (alive) setOrg(row)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [jwt, orgId])
  if (error) return <DirectoryError message={error} />
  if (!org) return <p className="text-sm text-muted-foreground">Loading organization…</p>
  return (
    <AdminOrgView
      key={org.id}
      jwt={jwt}
      org={org}
      tenantsHref={tenantsHref}
      onOpenInApp={onOpenInApp}
      onSelectUser={onSelectUser}
    />
  )
}

export function AdminTeamsTable({
  jwt,
  onOpenTeam,
}: {
  jwt: string
  onOpenTeam: (team: AdminTeam) => void
}) {
  const directory = useAdminDirectory<AdminTeam>({
    load: (query) => getAdminTeamsPage(jwt, query),
    queryKey: `teams:${jwt}`,
    initialSort: { id: "team", desc: false },
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DirectoryError message={directory.error} />
      <AdminTeamsSection teams={directory.rows} onOpenTeam={onOpenTeam} server={asServer(directory)} fill />
    </div>
  )
}

export function AdminPeopleTable({
  jwt,
  onSelectUser,
  initialSort,
}: {
  jwt: string
  onSelectUser: (userId: number) => void
  initialSort: "name" | "lastActive"
}) {
  const directory = useAdminDirectory<AdminUser>({
    load: (query) => getAdminUsersPage(jwt, query),
    queryKey: `people:${jwt}:${initialSort}`,
    initialSort: initialSort === "lastActive" ? { id: "lastActive", desc: true } : { id: "user", desc: false },
  })
  const [admins, setAdmins] = useState<AdminAdmin[]>([])
  useEffect(() => {
    let alive = true
    getAdminAdmins(jwt)
      .then((rows) => {
        if (alive) setAdmins(rows)
      })
      .catch(() => {
        if (alive) setAdmins([])
      })
    return () => {
      alive = false
    }
  }, [jwt])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DirectoryError message={directory.error} />
      <AdminPeopleSection
        users={directory.rows}
        admins={admins}
        onSelectUser={onSelectUser}
        initialSort={initialSort}
        server={asServer(directory)}
        fill
      />
    </div>
  )
}

export function AdminProjectsTable({
  jwt,
  initialLens,
  onSelectOrg,
}: {
  jwt: string
  initialLens: Lens
  onSelectOrg: (orgId: number) => void
}) {
  const [lens, setLens] = useState<Lens>(initialLens)
  const directory = useAdminDirectory<AdminProject>({
    load: (query) => getAdminProjectsPage(jwt, { ...query, lens }),
    queryKey: `projects:${jwt}:${lens}`,
    initialSort: lens === "needs-attention" ? { id: "status", desc: true } : { id: "name", desc: false },
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DirectoryError message={directory.error} />
      <AdminProjectsSection
        projects={directory.rows}
        initialLens={lens}
        onSelectOrg={onSelectOrg}
        server={{ ...asServer(directory), lens, onLensChange: setLens }}
        fill
      />
    </div>
  )
}

export function AdminActivityTab({ jwt }: { jwt: string }) {
  const [activity, setActivity] = useState<AdminActivity[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    getAdminActivity(jwt, 200)
      .then((rows) => {
        if (alive) setActivity(rows)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [jwt])
  return (
    <Section title="Activity" description="Cross-tenant events, most recent first.">
      {error ? (
        <DirectoryError message={error} />
      ) : activity == null ? (
        <p className="text-sm text-muted-foreground">Loading activity…</p>
      ) : (
        <AdminActivityTimeline activity={activity} />
      )}
    </Section>
  )
}

/** Invites still needs the full pickers. They load only when this tab is open. */
export function AdminInvitesTab({ jwt, initialOrgId }: { jwt: string; initialOrgId?: number }) {
  const [data, setData] = useState<{ orgs: AdminOrg[]; projects: AdminProject[]; users: AdminUser[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([getAdminOrgs(jwt), getAdminProjects(jwt), getAdminUsers(jwt)])
      .then(([orgs, projects, users]) => {
        if (alive) setData({ orgs, projects, users })
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [jwt])
  if (error) return <DirectoryError message={error} />
  if (!data) return <p className="text-sm text-muted-foreground">Loading invites…</p>
  return (
    <AdminInvitesSection
      jwt={jwt}
      orgs={data.orgs}
      projects={data.projects}
      users={data.users}
      initialOrgId={initialOrgId}
    />
  )
}
