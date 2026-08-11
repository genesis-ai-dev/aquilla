import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { FolderOpen } from "lucide-react"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { EmptyState } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ProjectStatus } from "@/components/ProjectStatus"
import { ValidatedBar } from "./ValidatedBar"
import { attentionReasons, attentionScore, validatedFraction } from "@/lib/admin/insights"
import type { AdminProject } from "@/lib/frontier/admin"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"

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
        id: "creator",
        accessorFn: (p) => missingLast((p.creatorUsername ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Creator" />,
        cell: ({ row }) =>
          row.original.creatorUsername ? (
            <UsernameWithAvatar
              username={row.original.creatorUsername}
              size="xs"
              nameClassName="font-normal"
            />
          ) : (
            "—"
          ),
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
        accessorFn: (p) => missingLast(p.lastEditAt ?? undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last edit" />,
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
            <ProjectStatus
              archived={p.archived}
              reasons={attentionReasons(p, now)}
              deadlineAt={p.deadlineAt}
            />
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
    <EmptyState
      variant="inline"
      className="flex-none py-12"
      icon={FolderOpen}
      title={emptyCopy.title}
      description={emptyCopy.description}
    />
  )

  const initialSorting = useMemo(
    () =>
      lens === "needs-attention"
        ? [{ id: "status", desc: true }]
        : [{ id: "name", desc: false }],
    [lens],
  )

  return (
    <DataTable
      // Remount when the lens changes so sort resets to the lens default
      // (status urgency for needs-attention; name A→Z otherwise).
      key={lens}
      columns={columns}
      data={data}
      getRowId={(p) => p.id}
      onRowClick={(p) => {
        if (!p.archived) navigate(`/projects/${p.id}`)
      }}
      initialSorting={initialSorting}
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
        <>
          <Select
            items={LENSES}
            value={lens}
            onValueChange={(v) => setLens((v as Lens) ?? "all")}
          >
            <SelectTrigger className="bg-card" aria-label="Filter projects">
              <SelectValue className="flex-none" />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                {LENSES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {table.getFilteredRowModel().rows.length === data.length
              ? `${data.length}`
              : `${table.getFilteredRowModel().rows.length} of ${data.length}`}
          </span>
        </>
      )}
      emptyState={emptyState}
      testId="admin-projects-table"
      className={ADMIN_TABLE_PANEL_CLASS}
      dense
    />
  )
}
