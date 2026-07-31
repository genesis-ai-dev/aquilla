import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { EmptyState } from "@/components/ui/empty"
import { ProjectStatus } from "@/components/ProjectStatus"
import { ValidatedBar } from "./ValidatedBar"
import { attentionReasons, attentionScore, validatedFraction } from "@/lib/admin/insights"
import type { AdminProject } from "@/lib/frontier/admin"
import { DateTooltip } from "@/components/ui/date-tooltip"

type Lens = "all" | "needs-attention" | "active" | "archived"
const LENSES: { value: Lens; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs-attention", label: "Needs attention" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

/**
 * Projects — searchable, sortable, and filterable by a lens (all / needs-attention /
 * active / archived). The Status column shows why a project needs attention
 * (overdue / due-soon / stalled) instead of a bare "Active", turning the old
 * flat table into something an operator can triage from.
 */
export function AdminProjectsSection({ projects }: { projects: AdminProject[] }) {
  const navigate = useNavigate()
  const [now] = useState(() => Date.now())
  const [lens, setLens] = useState<Lens>("all")

  const data = useMemo(() => {
    switch (lens) {
      case "needs-attention":
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
          return (
            <span className={p.archived ? "text-muted-foreground" : "font-medium text-foreground"}>
              {p.name}
            </span>
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
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.lastEditAt}
            label="Edited"
            className="text-muted-foreground"
          />
        ),
      },
      {
        id: "status",
        accessorFn: (p) => (p.archived ? -1 : attentionScore(p, now)),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => {
          const p = row.original
          return (
            <ProjectStatus archived={p.archived} reasons={attentionReasons(p, now)} />
          )
        },
      },
    ],
    [now],
  )

  const emptyCopy = useMemo(() => {
    switch (lens) {
      case "needs-attention":
        return {
          title: "Nothing needs attention",
          description: "No active project is overdue, due soon, or stalled.",
        }
      case "active":
        return {
          title: "No active projects",
          description: "Active projects appear here.",
        }
      case "archived":
        return {
          title: "No archived projects",
          description: "Archived projects appear here.",
        }
      default:
        return {
          title: "No projects",
          description: "Projects appear here as they're created.",
        }
    }
  }, [lens])

  const emptyState = (
    <div
      className="w-full overflow-hidden rounded-md border border-dashed"
      data-testid="admin-projects-empty"
    >
      <EmptyState
        variant="inline"
        className="flex-none py-12"
        icon={FolderOpen}
        title={emptyCopy.title}
        description={emptyCopy.description}
      />
    </div>
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

      <DataTable
        columns={columns}
        data={data}
        getRowId={(p) => p.id}
        onRowClick={(p) => {
          if (!p.archived) navigate(`/projects/${p.id}`)
        }}
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
        emptyState={emptyState}
        testId="admin-projects-table"
        dense
      />
    </div>
  )
}
