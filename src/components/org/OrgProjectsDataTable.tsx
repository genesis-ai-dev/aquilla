import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { FolderOpen } from "lucide-react"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import {
  attentionRank,
  audioPct,
  deadlineStatus,
  translatedPct,
  validatedPct,
  type PortfolioProject,
} from "@/lib/frontier/portfolio"
import { portfolioActivityStatus } from "@/lib/project-status"
import { ProjectDeadlineStatuses } from "@/components/ProjectStatus"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { AppTooltip } from "@/components/ui/tooltip"

export type OrgProjectRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
}

function activityLabel(project: PortfolioProject, now: number): string | null {
  const status = portfolioActivityStatus(project, now)
  if (status === "not-started") return "Not started"
  if (status === "stalled") return "Stalled"
  return null
}

type ProjectLens = "recent" | "attention" | "least-translated" | "most-progress" | "name"

function lensToSorting(lens: ProjectLens) {
  switch (lens) {
    case "recent":
      return [{ id: "edited", desc: true }] as const
    case "attention":
      return [{ id: "attention", desc: true }] as const
    case "least-translated":
      return [{ id: "translated", desc: false }] as const
    case "most-progress":
      return [{ id: "translated", desc: true }] as const
    case "name":
      return [{ id: "name", desc: false }] as const
  }
}

export function OrgProjectsDataTable({
  projects,
  now,
  showOrg = false,
  roleByProjectId,
  initialLens = "recent",
  emptyTitle = "No projects yet.",
  emptyDescription,
  testId = "org-projects-table",
}: {
  projects: OrgProjectRow[]
  now: number
  showOrg?: boolean
  roleByProjectId?: Map<string, CloudProjectSummary["role"]>
  initialLens?: ProjectLens
  emptyTitle?: string
  emptyDescription?: string
  testId?: string
}) {
  const navigate = useNavigate()
  const [tableNow] = useState(() => now)

  const tableData = useMemo(() => {
    if (initialLens === "attention") {
      return [...projects].sort((a, b) => attentionRank(b, tableNow) - attentionRank(a, tableNow))
    }
    return projects
  }, [projects, initialLens, tableNow])

  const columns = useMemo<ColumnDef<OrgProjectRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => {
          const p = row.original
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{p.name}</span>
              {showOrg && p.orgName && (
                <Badge variant="secondary" className="max-w-[8rem] shrink-0 truncate">
                  {p.orgName}
                </Badge>
              )}
              <ProjectDeadlineStatuses deadline={deadlineStatus(p, tableNow)} className="shrink-0" />
            </span>
          )
        },
      },
      {
        id: "translated",
        accessorFn: (p) => translatedPct(p),
        meta: { align: "right" },
        header: ({ column }) => (
          <AppTooltip content="Percentage of cells with target-language content filled in.">
            <span className="inline-flex">
              <DataTableColumnHeader column={column} title="Translated" className="justify-end" />
            </span>
          </AppTooltip>
        ),
        cell: ({ row }) => {
          const pct = Math.round(translatedPct(row.original) * 100)
          return (
            <div className="text-right font-medium tabular-nums text-foreground" aria-label={`${pct}% translated`}>
              {pct}%
            </div>
          )
        },
      },
      {
        id: "validated",
        accessorFn: (p) => validatedPct(p),
        meta: { align: "right" },
        header: ({ column }) => (
          <AppTooltip content="Percentage of cells marked validated by a reviewer.">
            <span className="inline-flex">
              <DataTableColumnHeader column={column} title="Validated" className="justify-end" />
            </span>
          </AppTooltip>
        ),
        cell: ({ row }) => {
          const pct = Math.round(validatedPct(row.original) * 100)
          return (
            <div className="text-right tabular-nums text-muted-foreground" aria-label={`${pct}% validated`}>
              {pct}%
            </div>
          )
        },
      },
      {
        id: "audio",
        accessorFn: (p) => audioPct(p),
        meta: { align: "right" },
        header: ({ column }) => (
          <AppTooltip content="Percentage of cells that have at least one audio recording attached. This is coverage, not validation — audio-specific validation isn't tracked yet (see AQU-490).">
            <span className="inline-flex">
              <DataTableColumnHeader column={column} title="Has Audio" className="justify-end" />
            </span>
          </AppTooltip>
        ),
        cell: ({ row }) => {
          const pct = Math.round(audioPct(row.original) * 100)
          return (
            <div className="text-right tabular-nums text-muted-foreground" aria-label={`${pct}% audio`}>
              {pct}%
            </div>
          )
        },
      },
      {
        id: "role",
        accessorFn: (p) => roleByProjectId?.get(p.id)?.name ?? "",
        enableSorting: false,
        meta: { align: "right" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" className="justify-end" />,
        cell: ({ row }) => (
          <div className="truncate text-right text-xs text-muted-foreground">
            {roleByProjectId?.get(row.original.id)?.name.replace(/_/g, " ") ?? "—"}
          </div>
        ),
      },
      {
        id: "edited",
        accessorFn: (p) => p.lastEditAt ?? null,
        meta: { align: "right" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" className="justify-end" />,
        sortingFn: (a, b) => {
          const av = a.original.lastEditAt
          const bv = b.original.lastEditAt
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return av < bv ? -1 : av > bv ? 1 : 0
        },
        cell: ({ row }) => {
          const status = portfolioActivityStatus(row.original, tableNow)
          const label = activityLabel(row.original, tableNow)
          if (label) {
            return (
              <div
                className={`truncate text-right text-xs ${
                  status === "stalled" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                }`}
              >
                {label}
              </div>
            )
          }
          return (
            <div className="truncate text-right text-xs text-muted-foreground">
              <DateTooltip
                value={row.original.lastEditAt}
                label="Edited"
                className="text-muted-foreground"
              />
            </div>
          )
        },
      },
    ],
    [roleByProjectId, showOrg, tableNow],
  )

  const emptyState = (
    <div
      className="w-full overflow-hidden rounded-md border border-dashed"
      data-testid="org-projects-empty"
    >
      <Empty className="flex-none rounded-none border-0 bg-transparent py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpen />
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          {emptyDescription ? <EmptyDescription>{emptyDescription}</EmptyDescription> : null}
        </EmptyHeader>
      </Empty>
    </div>
  )

  return (
    <DataTable
      columns={columns}
      data={tableData}
      getRowId={(p) => p.id}
      onRowClick={(p) => navigate(`/projects/${p.id}`)}
      rowClassName="cursor-pointer"
      initialSorting={
        initialLens === "attention" ? [] : [...lensToSorting(initialLens)]
      }
      searchPlaceholder="Filter projects by name"
      globalFilterFn={(row, _columnId, filterValue) => {
        const q = String(filterValue).trim().toLowerCase()
        if (!q) return true
        const p = row.original
        return `${p.name} ${p.orgName ?? ""}`.toLowerCase().includes(q)
      }}
      toolbar={(table) => (
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {table.getFilteredRowModel().rows.length === tableData.length
            ? `${tableData.length}`
            : `${table.getFilteredRowModel().rows.length} of ${tableData.length}`}
        </span>
      )}
      emptyState={emptyState}
      testId={testId}
      dense
    />
  )
}
