import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronDown, ChevronRight, CircleCheck, FolderOpen, Mic, Sparkles } from "lucide-react"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import {
  attentionRank,
  audioPct,
  deadlineStatus,
  translatedPct,
  validatedPct,
  type PortfolioProject,
} from "@/lib/frontier/portfolio"
import { ROLE } from "@/lib/frontier/roles"
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
import { LaneChips } from "./LaneChips"
import { ProjectMetricHeader } from "./ProjectMetricHeader"
import { AddLanguagePopover } from "./AddLanguagePopover"
import { ProjectLaneSubRows } from "./ProjectLaneSubRows"
import { OrgLaneAssignModal } from "./OrgLaneAssignModal"
import { displayLanes } from "./project-lanes"

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

type ProjectLens = "recent" | "attention" | "least-translated" | "most-progress" | "name" | "pm"

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
    case "pm":
      // AQU-507: ascending by PM username; the column's sortingFn keeps
      // unassigned rows last regardless of direction.
      return [{ id: "pm", desc: false }] as const
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
  defaultLaneLabelByProjectId,
  filesByProjectId,
  orgId = null,
  jwt,
  author,
  allowSelfAssignment = false,
  callerUserId = null,
  onLanesChanged,
  onLaneAdded,
}: {
  projects: OrgProjectRow[]
  now: number
  showOrg?: boolean
  roleByProjectId?: Map<string, CloudProjectSummary["role"]>
  initialLens?: ProjectLens
  emptyTitle?: string
  emptyDescription?: string
  testId?: string
  /** AQU-538 §3.2: project → default target language, labeling the '' lane chip. */
  defaultLaneLabelByProjectId?: Map<string, string>
  /** AQU-538 §3.2: project → its files, for the lane sub-row "Assign…" action. */
  filesByProjectId?: Map<string, { id: string; name: string }[]>
  /** The active org id — threaded to StaffLanePopover / AssignModal. */
  orgId?: number | null
  /** JWT — required to enable the "+ Language" and "Assign…" lane actions. */
  jwt?: string | null
  /** Current username — stamped as the assignment event author. */
  author?: string
  allowSelfAssignment?: boolean
  callerUserId?: number | null
  /** Called after an assign/staff lane action, so the parent can refetch the
   * portfolio (per-lane rollups changed). */
  onLanesChanged?: () => void
  /** AQU-605: called with (projectId, lane) after a "+ Language" add so the
   * parent can insert the lane in place — no full-table refetch/reload. */
  onLaneAdded?: (projectId: string, lane: string) => void
}) {
  const navigate = useNavigate()
  const [tableNow] = useState(() => now)
  // AQU-538 §3.2: which project rows are expanded into their per-lane detail.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // The lane "Assign…" currently open (project + lane), or null.
  const [assignTarget, setAssignTarget] = useState<{ projectId: string; lane: string } | null>(null)

  const toggleExpand = useCallback((projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }, [])

  const canAddLanguage = useCallback(
    (projectId: string) => {
      const level = roleByProjectId?.get(projectId)?.level
      // §3.2: enabled for maintainer 600+; when the row's role is unknown, show
      // it anyway and let the PATCH 403 surface gracefully.
      return level == null || level >= ROLE.MAINTAINER
    },
    [roleByProjectId],
  )

  const tableData = useMemo(() => {
    if (initialLens === "attention") {
      return [...projects].sort((a, b) => attentionRank(b, tableNow) - attentionRank(a, tableNow))
    }
    return projects
  }, [projects, initialLens, tableNow])

  const columns = useMemo<ColumnDef<OrgProjectRow>[]>(
    () => [
      {
        id: "expand",
        enableSorting: false,
        header: () => <span className="sr-only">Expand languages</span>,
        cell: ({ row }) => {
          const isOpen = expanded.has(row.original.id)
          return (
            <button
              type="button"
              data-testid={`project-lanes-expand-${row.original.id}`}
              aria-label={isOpen ? "Collapse languages" : "Expand languages"}
              aria-expanded={isOpen}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(row.original.id)
              }}
            >
              {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          )
        },
      },
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
        id: "languages",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Language" />,
        cell: ({ row }) => {
          const p = row.original
          return (
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <LaneChips
                projectId={p.id}
                lanes={displayLanes(p)}
                defaultLaneLabel={defaultLaneLabelByProjectId?.get(p.id) ?? ""}
                onOverflowClick={() => toggleExpand(p.id)}
                className="flex-1"
              />
              {jwt && canAddLanguage(p.id) && (
                <AddLanguagePopover
                  projectId={p.id}
                  jwt={jwt}
                  onAdded={(lane) => onLaneAdded?.(p.id, lane)}
                />
              )}
            </div>
          )
        },
      },
      {
        id: "translated",
        accessorFn: (p) => translatedPct(p),
        header: ({ column }) => (
          <ProjectMetricHeader
            label="Translated"
            description="Translated: percentage of cells with target-language content filled in."
            icon={Sparkles}
            testId="project-table-translated-header"
            sorted={column.getIsSorted()}
            onSort={column.getToggleSortingHandler()}
          />
        ),
        cell: ({ row }) => {
          const pct = Math.round(translatedPct(row.original) * 100)
          return (
            <div
              data-testid="project-table-translated-value"
              className="text-left font-medium tabular-nums text-foreground"
              aria-label={`${pct}% translated`}
            >
              {pct}%
            </div>
          )
        },
      },
      {
        id: "validated",
        accessorFn: (p) => validatedPct(p),
        header: ({ column }) => (
          <ProjectMetricHeader
            label="Validated"
            description="Validated: percentage of cells marked validated by a reviewer."
            icon={CircleCheck}
            testId="project-table-validated-header"
            sorted={column.getIsSorted()}
            onSort={column.getToggleSortingHandler()}
          />
        ),
        cell: ({ row }) => {
          const pct = Math.round(validatedPct(row.original) * 100)
          return (
            <div
              data-testid="project-table-validated-value"
              className="text-left tabular-nums text-muted-foreground"
              aria-label={`${pct}% validated`}
            >
              {pct}%
            </div>
          )
        },
      },
      {
        id: "audio",
        accessorFn: (p) => audioPct(p),
        header: ({ column }) => (
          <ProjectMetricHeader
            label="Has audio"
            description="Audio: percentage of cells with at least one recording attached."
            icon={Mic}
            testId="project-table-audio-header"
            sorted={column.getIsSorted()}
            onSort={column.getToggleSortingHandler()}
          />
        ),
        cell: ({ row }) => {
          const pct = Math.round(audioPct(row.original) * 100)
          return (
            <div
              data-testid="project-table-audio-value"
              className="text-left tabular-nums text-muted-foreground"
              aria-label={`${pct}% audio`}
            >
              {pct}%
            </div>
          )
        },
      },
      {
        id: "role",
        accessorFn: (p) => roleByProjectId?.get(p.id)?.name ?? "",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        cell: ({ row }) => (
          <div className="truncate text-left text-xs text-muted-foreground">
            {roleByProjectId?.get(row.original.id)?.name.replace(/_/g, " ") ?? "—"}
          </div>
        ),
      },
      {
        // AQU-507: designated Project Manager. Sortable; unassigned rows sort
        // last (see sortingFn) so scanning "by PM" surfaces owned projects first.
        id: "pm",
        accessorFn: (p) => p.pm?.username ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="PM" />,
        sortingFn: (a, b) => {
          const av = a.original.pm?.username ?? null
          const bv = b.original.pm?.username ?? null
          if (av && bv) return av.localeCompare(bv)
          if (av) return -1
          if (bv) return 1
          return 0
        },
        cell: ({ row }) => {
          const username = row.original.pm?.username
          return username ? (
            <div className="truncate text-left text-xs text-muted-foreground">{username}</div>
          ) : (
            <div className="truncate text-left text-xs text-muted-foreground/60">Unassigned</div>
          )
        },
      },
      {
        id: "edited",
        accessorFn: (p) => p.lastEditAt ?? null,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
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
                className={`truncate text-left text-xs ${
                  status === "stalled" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                }`}
              >
                {label}
              </div>
            )
          }
          return (
            <div className="truncate text-left text-xs text-muted-foreground">
              <DateTooltip
                value={row.original.lastEditAt}
                label="Updated"
                className="text-muted-foreground"
              />
            </div>
          )
        },
      },
    ],
    [
      roleByProjectId,
      showOrg,
      tableNow,
      expanded,
      toggleExpand,
      canAddLanguage,
      defaultLaneLabelByProjectId,
      jwt,
      onLaneAdded,
    ],
  )

  const colSpan = columns.length
  const canAssign = Boolean(jwt && author != null)

  const assignProject = assignTarget
    ? projects.find((p) => p.id === assignTarget.projectId) ?? null
    : null

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
    <>
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
          // AQU-507: match PM username too, so the search box satisfies the
          // "filter by PM" half of the AC without a separate filter control.
          return `${p.name} ${p.orgName ?? ""} ${p.pm?.username ?? ""}`.toLowerCase().includes(q)
        }}
        toolbar={(table) => (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {table.getFilteredRowModel().rows.length === tableData.length
              ? `${tableData.length}`
              : `${table.getFilteredRowModel().rows.length} of ${tableData.length}`}
          </span>
        )}
        renderSubRow={(p) =>
          expanded.has(p.id) ? (
            <ProjectLaneSubRows
              projectId={p.id}
              lanes={displayLanes(p)}
              defaultLaneLabel={defaultLaneLabelByProjectId?.get(p.id) ?? ""}
              colSpan={colSpan}
              orgId={orgId}
              onAssign={
                canAssign ? (lane) => setAssignTarget({ projectId: p.id, lane }) : undefined
              }
              onStaffed={onLanesChanged}
            />
          ) : null
        }
        emptyState={emptyState}
        testId={testId}
        dense
      />
      {assignTarget && assignProject && jwt && author != null && (
        <OrgLaneAssignModal
          projectId={assignTarget.projectId}
          lane={assignTarget.lane}
          targetLanes={displayLanes(assignProject)
            .map((l) => l.lane)
            .filter((l) => l !== "")}
          files={filesByProjectId?.get(assignTarget.projectId) ?? []}
          roleLevel={roleByProjectId?.get(assignTarget.projectId)?.level ?? ROLE.PROJECT_LEAD}
          jwt={jwt}
          author={author}
          allowSelfAssignment={allowSelfAssignment}
          callerUserId={callerUserId}
          onAssigned={() => {
            onLanesChanged?.()
          }}
          onClose={() => setAssignTarget(null)}
        />
      )}
    </>
  )
}
