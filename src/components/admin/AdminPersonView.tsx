import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { Building2, ChevronLeft, FolderOpen } from "lucide-react"
import { Section } from "@/components/ui/page"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { TableEmptyState } from "@/components/ui/empty"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { adminOrgHref } from "@/lib/admin/drilldown-paths"
import { roleDisplayLabel } from "@/lib/frontier/roles"
import { getAdminUser, type AdminUserDetail } from "@/lib/frontier/admin"

type OrgRow = AdminUserDetail["orgs"][number]
type ProjectRow = AdminUserDetail["projects"][number]

/**
 * One person, seen by a platform admin: account details, the orgs they belong
 * to (click for the org page), and the projects they were added to directly.
 */
export function AdminPersonView({
  jwt,
  userId,
  peopleHref,
  onSelectOrg,
}: {
  jwt: string
  userId: number
  /** Where the back link goes: the People list. */
  peopleHref: string
  onSelectOrg: (orgId: number) => void
}) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getAdminUser(jwt, userId)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch((err) => {
        if (!alive) return
        const status = (err as { status?: number } | null)?.status
        setError(status === 404 ? "This person was not found." : err instanceof Error && err.message ? err.message : "Could not load this person.")
      })
    return () => {
      alive = false
    }
  }, [jwt, userId])

  const orgColumns = useMemo<ColumnDef<OrgRow>[]>(
    () => [
      {
        id: "org",
        accessorFn: (o) => (o.name ?? `#${o.orgId}`).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Organization" />,
        cell: ({ row }) => (
          <OrgWithAvatar
            name={row.original.name ?? `#${row.original.orgId}`}
            size="xs"
            nameClassName="font-normal"
          />
        ),
      },
      {
        id: "role",
        accessorFn: (o) => o.roleLevel,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        cell: ({ row }) => roleDisplayLabel(row.original.roleLevel),
      },
      {
        id: "lastActive",
        accessorFn: (o) => missingLast(o.lastActiveAt ? Date.parse(o.lastActiveAt) : undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last active" />,
        cell: ({ row }) => <DateTooltip value={row.original.lastActiveAt} label="Last active" />,
      },
    ],
    [],
  )

  const projectColumns = useMemo<ColumnDef<ProjectRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (p) => p.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        cell: ({ row }) => (
          <span className={row.original.archived ? "text-muted-foreground" : "font-medium text-foreground"}>
            {row.original.name}
            {row.original.archived ? " (archived)" : ""}
          </span>
        ),
      },
      {
        id: "org",
        accessorFn: (p) => missingLast((p.orgName ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Org" />,
        cell: ({ row }) =>
          row.original.orgName ? (
            <OrgWithAvatar name={row.original.orgName} size="xs" nameClassName="font-normal" />
          ) : (
            "—"
          ),
      },
      {
        id: "role",
        accessorFn: (p) => p.roleLevel,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        cell: ({ row }) => roleDisplayLabel(row.original.roleLevel),
      },
    ],
    [],
  )

  const back = (
    <Link
      to={peopleHref}
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-4" aria-hidden />
      All people
    </Link>
  )

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="text-sm text-muted-foreground">Loading person…</p>
      </div>
    )
  }

  const { user } = detail
  return (
    <div className="flex flex-col gap-6" data-testid="admin-person-view">
      <div className="flex flex-col gap-3">
        {back}
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            {user.displayName || user.username}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {user.username} · {user.email} · joined <DateTooltip value={user.createdAt} label="Joined" />
          </p>
        </div>
      </div>

      <Section title="Organizations" description="Orgs this person belongs to.">
        <DataTable
          columns={orgColumns}
          data={detail.orgs}
          getRowId={(o) => String(o.orgId)}
          onRowClick={(o) => onSelectOrg(o.orgId)}
          rowLink={{ columnId: "org", to: (o) => adminOrgHref(o.orgId) }}
          initialSorting={[{ id: "org", desc: false }]}
          emptyState={
            <TableEmptyState
              icon={Building2}
              title="No organizations"
              description="This person is not a member of any org."
            />
          }
          testId="admin-person-orgs-table"
          className={ADMIN_TABLE_PANEL_CLASS}
          dense
        />
      </Section>

      <Section
        title="Projects"
        description="Projects this person was added to directly. Access through an org role or a team is not listed."
      >
        <DataTable
          columns={projectColumns}
          data={detail.projects}
          getRowId={(p) => p.projectId}
          onRowClick={(p) => {
            if (!p.archived) navigate(`/projects/${p.projectId}`)
          }}
          rowLink={{ columnId: "name", to: (p) => `/projects/${p.projectId}` }}
          initialSorting={[{ id: "name", desc: false }]}
          emptyState={
            <TableEmptyState
              icon={FolderOpen}
              title="No direct projects"
              description="This person has no direct project memberships."
            />
          }
          testId="admin-person-projects-table"
          className={ADMIN_TABLE_PANEL_CLASS}
          dense
        />
      </Section>
    </div>
  )
}
