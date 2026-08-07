import { useMemo } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Users } from "lucide-react"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { EmptyState } from "@/components/ui/empty"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { TeamWithAvatar } from "@/components/TeamWithAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { ADMIN_TABLE_PANEL_CLASS, relativeTeamPath } from "@/components/admin/shared"
import type { AdminTeam } from "@/lib/frontier/admin"

/**
 * Teams — flat cross-tenant list of every team. Complements Tenants (orgs with
 * a team count): operators who want to scan/search teams directly land here.
 * Row click opens the team in its org workspace.
 */
export function AdminTeamsSection({
  teams,
  onOpenTeam,
}: {
  teams: AdminTeam[]
  onOpenTeam: (team: AdminTeam) => void
}) {
  const columns = useMemo<ColumnDef<AdminTeam>[]>(
    () => [
      {
        id: "team",
        accessorFn: (t) => relativeTeamPath(t.name).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Team" />,
        cell: ({ row }) => {
          const local = relativeTeamPath(row.original.name)
          return <TeamWithAvatar name={local} nameClassName="font-normal" />
        },
      },
      {
        id: "organization",
        accessorFn: (t) => (t.orgName ?? `#${t.orgId}`).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Organization" />,
        cell: ({ row }) => {
          const name = row.original.orgName ?? `#${row.original.orgId}`
          return <OrgWithAvatar name={name} nameClassName="font-normal" />
        },
      },
      {
        id: "projectLead",
        accessorFn: (t) => (t.projectLeadUsername ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project Lead" />,
        cell: ({ row }) =>
          row.original.projectLeadUsername ? (
            <UsernameWithAvatar
              username={row.original.projectLeadUsername}
              nameClassName="font-normal"
            />
          ) : null,
      },
      {
        accessorKey: "memberCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Members" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.memberCount}</div>
        ),
      },
      {
        accessorKey: "projectCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Projects" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.projectCount}</div>
        ),
      },
      {
        id: "created",
        accessorFn: (t) => t.createdAt,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.createdAt}
            label="Created"
            className="text-muted-foreground"
          />
        ),
      },
    ],
    [],
  )

  if (teams.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={Users}
        title="No teams yet"
        description="Teams appear here as orgs create them."
      />
    )
  }

  return (
    <DataTable
      columns={columns}
      data={teams}
      getRowId={(t) => String(t.id)}
      onRowClick={onOpenTeam}
      initialSorting={[{ id: "team", desc: false }]}
      searchPlaceholder="Search teams…"
      globalFilterFn={(row, _columnId, filterValue) => {
        const q = String(filterValue).trim().toLowerCase()
        if (!q) return true
        const t = row.original
        return `${relativeTeamPath(t.name)} ${t.orgName ?? ""} ${t.projectLeadUsername ?? ""}`
          .toLowerCase()
          .includes(q)
      }}
      toolbar={(table) => (
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {table.getFilteredRowModel().rows.length === teams.length
            ? `${teams.length}`
            : `${table.getFilteredRowModel().rows.length} of ${teams.length}`}
        </span>
      )}
      testId="admin-teams-table"
      className={ADMIN_TABLE_PANEL_CLASS}
      dense
    />
  )
}
