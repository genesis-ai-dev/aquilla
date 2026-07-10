import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { FolderOpen } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { AttentionBadges, ValidatedBar } from "./shared"
import { fmtDate } from "@/lib/admin/format"
import { attentionReasons, attentionScore, validatedFraction } from "@/lib/admin/insights"
import type { AdminProject } from "@/lib/frontier/admin"

type Lens = "all" | "at-risk" | "active" | "archived"
const LENSES: { value: Lens; label: string }[] = [
  { value: "all", label: "All" },
  { value: "at-risk", label: "At risk" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

/**
 * Projects — searchable, sortable, and filterable by a lens (all / at-risk /
 * active / archived). The Status column shows why a project needs attention
 * (overdue / due-soon / stalled) instead of a bare "Active", turning the old
 * flat table into something an operator can triage from.
 */
export function AdminProjectsSection({ projects }: { projects: AdminProject[] }) {
  const [now] = useState(() => Date.now())
  const [lens, setLens] = useState<Lens>("all")

  const data = useMemo(() => {
    switch (lens) {
      case "at-risk":
        return projects.filter((p) => !p.archived && attentionReasons(p, now).length > 0)
      case "active":
        return projects.filter((p) => !p.archived)
      case "archived":
        return projects.filter((p) => p.archived)
      default:
        return projects
    }
  }, [projects, lens, now])

  const columns = useMemo<ColumnDef<AdminProject>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        cell: ({ row }) => {
          const p = row.original
          return p.archived ? (
            <span className="text-muted-foreground">{p.name}</span>
          ) : (
            <Link to={`/projects/${p.id}`} className="font-medium text-primary hover:underline">
              {p.name}
            </Link>
          )
        },
      },
      {
        id: "org",
        accessorFn: (p) => (p.orgName ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Org" />,
        cell: ({ row }) => row.original.orgName ?? "—",
      },
      {
        id: "creator",
        accessorFn: (p) => (p.creatorUsername ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Creator" />,
        cell: ({ row }) => row.original.creatorUsername ?? "—",
      },
      {
        id: "validated",
        accessorFn: (p) => validatedFraction(p),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Validated" />,
        cell: ({ row }) => <ValidatedBar fraction={validatedFraction(row.original)} />,
      },
      {
        accessorKey: "wordCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Words" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.wordCount.toLocaleString()}</div>
        ),
      },
      {
        id: "edited",
        accessorFn: (p) => p.lastEditAt ?? null,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last edit" />,
        sortingFn: (a, b) => {
          const av = a.original.lastEditAt
          const bv = b.original.lastEditAt
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return av < bv ? -1 : av > bv ? 1 : 0
        },
        cell: ({ row }) =>
          row.original.lastEditAt
            ? fmtDate(new Date(row.original.lastEditAt).toISOString())
            : "—",
      },
      {
        id: "status",
        accessorFn: (p) => (p.archived ? -1 : attentionScore(p, now)),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => {
          const p = row.original
          if (p.archived) return <Badge variant="secondary">Archived</Badge>
          const reasons = attentionReasons(p, now)
          return reasons.length > 0 ? (
            <AttentionBadges reasons={reasons} />
          ) : (
            <Badge variant="outline">On track</Badge>
          )
        },
      },
    ],
    [now],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {LENSES.map((l) => (
          <Button
            key={l.value}
            type="button"
            size="xs"
            variant={lens === l.value ? "default" : "secondary"}
            onClick={() => setLens(l.value)}
          >
            {l.label}
          </Button>
        ))}
      </div>

      {data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>{lens === "at-risk" ? "Nothing at risk" : "No projects"}</EmptyTitle>
            <EmptyDescription>
              {lens === "at-risk"
                ? "No active project is overdue, due soon, or stalled."
                : "Projects appear here as they're created."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={data}
          getRowId={(p) => p.id}
          initialSorting={[{ id: "status", desc: true }]}
          searchPlaceholder="Search projects…"
          globalFilterFn={(row, _columnId, filterValue) => {
            const q = String(filterValue).trim().toLowerCase()
            if (!q) return true
            const p = row.original
            return `${p.name} ${p.orgName ?? ""} ${p.creatorUsername ?? ""}`
              .toLowerCase()
              .includes(q)
          }}
          toolbar={(table) => (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {table.getFilteredRowModel().rows.length === data.length
                ? `${data.length}`
                : `${table.getFilteredRowModel().rows.length} of ${data.length}`}
            </span>
          )}
          testId="admin-projects-table"
        />
      )}
    </div>
  )
}
