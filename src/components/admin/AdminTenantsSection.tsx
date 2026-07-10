import { useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Building2, ChevronRight, ExternalLink, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { EmptyState } from "@/components/ui/empty"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { AdminOrg, AdminTeam } from "@/lib/frontier/admin"

/**
 * Tenants — the merge of the old Orgs and Teams tabs. Orgs are the rows;
 * expanding one reveals its teams inline (teams always nest under an org), so
 * the two flat tables become one navigable hierarchy. "Open" drills into the
 * org workspace (platform admins resolve owner-level everywhere).
 */

/** GitLab full_paths lead with the org's own path; drop it so a team reads locally. */
function relativeTeamPath(name: string): string {
  const i = name.indexOf("/")
  return i === -1 ? name : name.slice(i + 1)
}

export function AdminTenantsSection({
  orgs,
  teams,
  onOpenOrg,
}: {
  orgs: AdminOrg[]
  teams: AdminTeam[]
  onOpenOrg: (orgId: number) => void
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const teamsByOrg = useMemo(() => {
    const map = new Map<number, AdminTeam[]>()
    for (const t of teams) {
      const list = map.get(t.orgId) ?? []
      list.push(t)
      map.set(t.orgId, list)
    }
    return map
  }, [teams])

  const toggle = (orgId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(orgId)) next.delete(orgId)
      else next.add(orgId)
      return next
    })

  const columns = useMemo<ColumnDef<AdminOrg>[]>(
    () => [
      {
        id: "expand",
        enableSorting: false,
        header: () => null,
        cell: ({ row }) => {
          const o = row.original
          const orgTeams = teamsByOrg.get(o.id) ?? []
          const isOpen = expanded.has(o.id)
          return (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => toggle(o.id)}
              disabled={orgTeams.length === 0}
              aria-expanded={isOpen}
              aria-label={isOpen ? `Collapse ${o.name ?? o.id}` : `Expand ${o.name ?? o.id}`}
            >
              <ChevronRight className={cn(isOpen && "rotate-90")} />
            </Button>
          )
        },
      },
      {
        id: "organization",
        accessorFn: (o) => (o.name ?? `#${o.id}`).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Organization" />,
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name ?? `#${row.original.id}`}</span>
        ),
      },
      {
        id: "owner",
        accessorFn: (o) => (o.ownerUsername ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Owner" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.ownerUsername ?? "—"}</span>
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
        id: "teams",
        accessorFn: (o) => (teamsByOrg.get(o.id) ?? []).length,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Teams" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {(teamsByOrg.get(row.original.id) ?? []).length}
          </div>
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
    [expanded, onOpenOrg, teamsByOrg],
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
      renderSubRow={(o) => {
        const orgTeams = teamsByOrg.get(o.id) ?? []
        if (!expanded.has(o.id) || orgTeams.length === 0) return null
        return (
          <TableRow className="bg-muted/20 hover:bg-muted/20">
            <TableCell />
            <TableCell colSpan={7}>
              <ul className="flex flex-col gap-1">
                {orgTeams.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <Users className="size-3 text-muted-foreground" />
                    <span className="font-medium text-foreground">{relativeTeamPath(t.name)}</span>
                    <span className="text-muted-foreground">
                      {t.memberCount} {t.memberCount === 1 ? "member" : "members"} · {t.projectCount}{" "}
                      {t.projectCount === 1 ? "project" : "projects"}
                    </span>
                  </li>
                ))}
              </ul>
            </TableCell>
          </TableRow>
        )
      }}
    />
  )
}
