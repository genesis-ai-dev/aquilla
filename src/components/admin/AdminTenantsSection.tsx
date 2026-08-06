import { useMemo } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Building2, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { EmptyState } from "@/components/ui/empty"
import type { AdminOrg, AdminTeam } from "@/lib/frontier/admin"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"

/**
 * Tenants — flat cross-tenant list of organizations. Team nesting lives on the
 * Teams tab; this table only shows a per-org team count. "Open" switches into
 * the org workspace (platform admins resolve owner-level everywhere).
 */

export function AdminTenantsSection({
  orgs,
  teams,
  onOpenOrg,
}: {
  orgs: AdminOrg[]
  teams: AdminTeam[]
  onOpenOrg: (orgId: number) => void
}) {
  const teamCountByOrg = useMemo(() => {
    const map = new Map<number, number>()
    for (const t of teams) {
      map.set(t.orgId, (map.get(t.orgId) ?? 0) + 1)
    }
    return map
  }, [teams])

  const columns = useMemo<ColumnDef<AdminOrg>[]>(
    () => [
      {
        id: "organization",
        accessorFn: (o) => (o.name ?? `#${o.id}`).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Organization" />,
        cell: ({ row }) => {
          const name = row.original.name ?? `#${row.original.id}`
          return <OrgWithAvatar name={name} />
        },
      },
      {
        id: "owner",
        accessorFn: (o) => (o.ownerUsername ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Owner" />,
        cell: ({ row }) =>
          row.original.ownerUsername ? (
            <UsernameWithAvatar
              username={row.original.ownerUsername}
              nameClassName="font-normal text-muted-foreground"
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "teams",
        accessorFn: (o) => teamCountByOrg.get(o.id) ?? 0,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Teams" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {teamCountByOrg.get(row.original.id) ?? 0}
          </div>
        ),
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
        accessorFn: (o) => o.createdAt,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.createdAt}
            label="Created"
            className="text-muted-foreground"
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => null,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => onOpenOrg(row.original.id)}
          >
            Open
            <ExternalLink data-icon="inline-end" />
          </Button>
        ),
      },
    ],
    [onOpenOrg, teamCountByOrg],
  )

  if (orgs.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={Building2}
        title="No organizations yet"
        description="Tenants appear here as orgs are created."
      />
    )
  }

  return (
    <DataTable
      columns={columns}
      data={orgs}
      getRowId={(o) => String(o.id)}
      searchPlaceholder="Search organizations…"
      globalFilterFn={(row, _columnId, filterValue) => {
        const q = String(filterValue).trim().toLowerCase()
        if (!q) return true
        const o = row.original
        return (
          (o.name ?? `#${o.id}`).toLowerCase().includes(q) ||
          (o.ownerUsername ?? "").toLowerCase().includes(q)
        )
      }}
      toolbar={(table) => (
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {table.getFilteredRowModel().rows.length === orgs.length
            ? `${orgs.length} orgs`
            : `${table.getFilteredRowModel().rows.length} of ${orgs.length} orgs`}
        </span>
      )}
      testId="admin-tenants-table"
      className={ADMIN_TABLE_PANEL_CLASS}
      dense
    />
  )
}
