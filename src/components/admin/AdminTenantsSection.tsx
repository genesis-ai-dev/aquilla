import { useMemo, type MouseEvent } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Building2 } from "lucide-react"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { TableEmptyState } from "@/components/ui/empty"
import type { AdminOrg, AdminTeam } from "@/lib/frontier/admin"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"

/**
 * Tenants — flat cross-tenant list of organizations. Team nesting lives on the
 * Teams tab; this table only shows a per-org team count. Row click switches
 * into the org workspace (platform admins resolve owner-level everywhere). The
 * trailing actions column jumps straight to an org's Members page or its
 * People & access page (AQU-1322); those buttons stop the click so the row
 * handler does not also fire.
 */

export function AdminTenantsSection({
  orgs,
  teams,
  onOpenOrg,
  onOpenOrgPath,
  onOpenInvites,
}: {
  orgs: AdminOrg[]
  teams: AdminTeam[]
  onOpenOrg: (orgId: number) => void
  /** Open an org subpage such as "/members" or "/access". */
  onOpenOrgPath: (orgId: number, subpath: string) => void
  /** Open the admin invites tab with this org pre-selected. */
  onOpenInvites?: (orgId: number) => void
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
          return <OrgWithAvatar name={name} size="xs" nameClassName="font-normal" />
        },
      },
      {
        id: "owner",
        accessorFn: (o) => missingLast((o.ownerUsername ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Owner" />,
        cell: ({ row }) =>
          row.original.ownerUsername ? (
            <UsernameWithAvatar
              username={row.original.ownerUsername}
              size="xs"
              nameClassName="font-normal"
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
          <div className="text-right tabular-nums">
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
        // AQU-1071: the billing band's own count, per tenant. Sorts missing last
        // so a server without the field cannot read as "fewest languages".
        id: "languages",
        accessorFn: (o) => missingLast(o.activeLanguageCount),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Languages" className="justify-end" />
        ),
        cell: ({ row }) =>
          row.original.activeLanguageCount == null ? (
            <div className="text-right text-muted-foreground">—</div>
          ) : (
            <div className="text-right tabular-nums">{row.original.activeLanguageCount}</div>
          ),
      },
      {
        id: "created",
        accessorFn: (o) => missingLast(o.createdAt || undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.createdAt}
            label="Created"
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => null,
        cell: ({ row }) => {
          const orgId = row.original.id
          const open = (subpath: string) => (e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            onOpenOrgPath(orgId, subpath)
          }
          const openInvites = (e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            onOpenInvites?.(orgId)
          }
          const linkClass = "text-xs text-primary hover:underline"
          return (
            <div className="flex justify-end gap-3 whitespace-nowrap">
              <button type="button" className={linkClass} onClick={open("/members")}>
                Members
              </button>
              <button type="button" className={linkClass} onClick={open("/access")}>
                People &amp; access
              </button>
              {onOpenInvites && (
                <button type="button" className={linkClass} onClick={openInvites}>
                  Invites &amp; links
                </button>
              )}
            </div>
          )
        },
      },
    ],
    [teamCountByOrg, onOpenOrgPath, onOpenInvites],
  )

  return (
    <DataTable
      columns={columns}
      data={orgs}
      getRowId={(o) => String(o.id)}
      onRowClick={(o) => onOpenOrg(o.id)}
      initialSorting={[{ id: "organization", desc: false }]}
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
      emptyState={
        orgs.length === 0 ? (
          <TableEmptyState
            icon={Building2}
            title="No organizations yet"
            description="Tenants appear here as orgs are created."
          />
        ) : undefined
      }
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
