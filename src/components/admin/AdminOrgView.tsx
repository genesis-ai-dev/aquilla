import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronLeft, ExternalLink, Users } from "lucide-react"
import { Section } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { TableEmptyState } from "@/components/ui/empty"
import { UserChip } from "@/components/UserChip"
import { AdminProjectsSection } from "@/components/admin/AdminProjectsSection"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { adminUserHref } from "@/lib/admin/drilldown-paths"
import { roleDisplayLabel } from "@/lib/frontier/roles"
import {
  getAdminOrgMembers,
  type AdminOrg,
  type AdminOrgMember,
  type AdminProject,
  type AdminTeam,
} from "@/lib/frontier/admin"

/**
 * One org, seen by a platform admin: header, the org's projects, and its
 * people. Projects come from the list the console already loaded; people are
 * fetched here. Teams are only a count.
 */
export function AdminOrgView({
  jwt,
  org,
  projects,
  teams,
  tenantsHref,
  onOpenInApp,
  onSelectUser,
}: {
  jwt: string
  org: AdminOrg
  projects: AdminProject[]
  teams: AdminTeam[]
  /** Where the back link goes: the Tenants list. */
  tenantsHref: string
  onOpenInApp: (orgId: number) => void
  onSelectUser: (userId: number) => void
}) {
  const [members, setMembers] = useState<AdminOrgMember[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getAdminOrgMembers(jwt, org.id)
      .then((rows) => {
        if (alive) setMembers(rows)
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [jwt, org.id])

  const orgProjects = useMemo(() => projects.filter((p) => p.orgId === org.id), [projects, org.id])
  const teamCount = useMemo(() => teams.filter((t) => t.orgId === org.id).length, [teams, org.id])
  const name = org.name ?? `#${org.id}`

  const columns = useMemo<ColumnDef<AdminOrgMember>[]>(
    () => [
      {
        id: "user",
        accessorFn: (m) => m.username.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Person" />,
        cell: ({ row }) => (
          <UserChip
            userId={row.original.userId}
            username={row.original.username}
            size="xs"
            nameClassName="font-normal"
          />
        ),
      },
      {
        accessorKey: "email",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.email}</span>,
      },
      {
        id: "role",
        accessorFn: (m) => m.roleLevel,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        cell: ({ row }) => roleDisplayLabel(row.original.roleLevel),
      },
      {
        id: "joined",
        accessorFn: (m) => missingLast(m.joinedAt ? Date.parse(m.joinedAt) : undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Joined" />,
        cell: ({ row }) => <DateTooltip value={row.original.joinedAt} label="Joined" />,
      },
      {
        id: "lastActive",
        accessorFn: (m) => missingLast(m.lastActiveAt ? Date.parse(m.lastActiveAt) : undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last active" />,
        cell: ({ row }) => <DateTooltip value={row.original.lastActiveAt} label="Last active" />,
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6" data-testid="admin-org-view">
      <div className="flex flex-col gap-3">
        <Link
          to={tenantsHref}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
          All tenants
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-heading text-xl font-semibold tracking-tight">{name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Owner {org.ownerUsername ?? "none"} · created{" "}
              <DateTooltip value={org.createdAt} label="Created" /> · {org.memberCount}{" "}
              {org.memberCount === 1 ? "member" : "members"} · {org.projectCount}{" "}
              {org.projectCount === 1 ? "project" : "projects"} · {teamCount}{" "}
              {teamCount === 1 ? "team" : "teams"}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenInApp(org.id)}>
            <ExternalLink className="size-4" aria-hidden />
            Open in app
          </Button>
        </div>
      </div>

      <Section title="Projects" description="Projects in this org, archived included.">
        <AdminProjectsSection projects={orgProjects} hideOrg />
      </Section>

      <Section title="People" description="Members of this org and their org role.">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : members == null ? (
          <p className="text-sm text-muted-foreground">Loading people…</p>
        ) : (
          <DataTable
            columns={columns}
            data={members}
            getRowId={(m) => String(m.userId)}
            onRowClick={(m) => onSelectUser(m.userId)}
            rowLink={{ columnId: "user", to: (m) => adminUserHref(m.userId) }}
            initialSorting={[{ id: "role", desc: true }]}
            searchPlaceholder="Search people…"
            globalFilterFn={(row, _columnId, filterValue) => {
              const q = String(filterValue).trim().toLowerCase()
              if (!q) return true
              const m = row.original
              return `${m.username} ${m.displayName ?? ""} ${m.email}`.toLowerCase().includes(q)
            }}
            emptyState={
              <TableEmptyState
                icon={Users}
                title="No members"
                description="People appear here when they join this org."
              />
            }
            testId="admin-org-people-table"
            className={ADMIN_TABLE_PANEL_CLASS}
            dense
          />
        )}
      </Section>
    </div>
  )
}
