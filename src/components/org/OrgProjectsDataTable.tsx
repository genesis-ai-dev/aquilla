import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { CircleCheck, FolderOpen, Mic, MoreHorizontal, Sparkles, UserPlus } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LaneChips } from "./LaneChips"
import { ProjectMetricHeader } from "./ProjectMetricHeader"
import { AddLanguagePopover } from "./AddLanguagePopover"
import { ProjectLaneSubRows } from "./ProjectLaneSubRows"
import { OrgLaneAssignModal } from "./OrgLaneAssignModal"
import { displayLanes } from "./project-lanes"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TFunction } from "@/lib/i18n/I18nProvider"

export type OrgProjectRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
}

function activityLabel(project: PortfolioProject, now: number, t: TFunction): string | null {
  const status = portfolioActivityStatus(project, now)
  if (status === "not-started") return t("autopilot.status.notStarted")
  if (status === "stalled") return t("org.orgHome.stalled")
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
  emptyTitle,
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
  const t = useT()
  const resolvedEmptyTitle = emptyTitle ?? t("org.orgHome.noProjectsYet")
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

  const canAssign = Boolean(jwt && author != null)

  const columns = useMemo<ColumnDef<OrgProjectRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.name")} />,
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
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.table.languageHeader")} />,
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
            label={t("org.orgHome.table.translatedHeaderLabel")}
            description={t("org.orgHome.table.translatedHeaderDescription")}
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
              className="text-start font-medium tabular-nums text-foreground"
              aria-label={t("org.orgHome.pctTranslated", { pct })}
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
            label={t("org.orgHome.table.validatedHeaderLabel")}
            description={t("org.orgHome.table.validatedHeaderDescription")}
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
              className="text-start tabular-nums text-muted-foreground"
              aria-label={t("org.orgHome.pctValidated", { pct })}
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
            label={t("org.orgHome.table.audioHeaderLabel")}
            description={t("org.orgHome.table.audioHeaderDescription")}
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
              className="text-start tabular-nums text-muted-foreground"
              aria-label={t("org.orgHome.table.audioPctAria", { pct })}
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
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.membersPage.roleLabel")} />,
        cell: ({ row }) => (
          <div className="truncate text-start text-xs text-muted-foreground">
            {roleByProjectId?.get(row.original.id)?.name.replace(/_/g, " ") ?? "—"}
          </div>
        ),
      },
      {
        // AQU-507: designated Project Manager. Sortable; unassigned rows sort
        // last (see sortingFn) so scanning "by PM" surfaces owned projects first.
        id: "pm",
        accessorFn: (p) => p.pm?.username ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgProjectsDataTable.pmColumn")} />,
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
            <div className="truncate text-start text-xs text-muted-foreground">{username}</div>
          ) : (
            <div className="truncate text-start text-xs text-muted-foreground/60">{t("org.projectOverview.unassigned")}</div>
          )
        },
      },
      {
        id: "edited",
        accessorFn: (p) => p.lastEditAt ?? null,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgProjectsDataTable.updatedColumn")} />,
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
          const label = activityLabel(row.original, tableNow, t)
          if (label) {
            return (
              <div
                className={`truncate text-start text-xs ${
                  status === "stalled" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                }`}
              >
                {label}
              </div>
            )
          }
          return (
            <div className="truncate text-start text-xs text-muted-foreground">
              <DateTooltip
                value={row.original.lastEditAt}
                label={t("org.orgProjectsDataTable.updatedColumn")}
                className="text-muted-foreground"
              />
            </div>
          )
        },
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">{t("org.orgProjectsDataTable.actionsColumnSrOnly")}</span>,
        cell: ({ row }) => {
          const p = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                data-testid={`project-row-actions-${p.id}`}
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("org.orgProjectsDataTable.moreActionsAriaLabel", { name: p.name })}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent
                align="end"
                className="min-w-40"
                onClick={(e) => e.stopPropagation()}
              >
                {canAssign && (
                  <DropdownMenuItem
                    onClick={() => setAssignTarget({ projectId: p.id, lane: "" })}
                  >
                    <UserPlus className="size-4" />
                    {t("dialog.assign.title")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => navigate(`/project/${p.id}/members`)}
                >
                  {t("org.teamDetail.addMemberButton")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    [
      roleByProjectId,
      showOrg,
      tableNow,
      toggleExpand,
      canAddLanguage,
      defaultLaneLabelByProjectId,
      jwt,
      onLaneAdded,
      canAssign,
      navigate,
      t,
    ],
  )

  const colSpan = columns.length

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
          <EmptyTitle>{resolvedEmptyTitle}</EmptyTitle>
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
        initialSorting={
          initialLens === "attention" ? [] : [...lensToSorting(initialLens)]
        }
        searchPlaceholder={t("org.orgHome.projectsPanel.filterAria")}
        globalFilterFn={(row, _columnId, filterValue) => {
          const q = String(filterValue).trim().toLowerCase()
          if (!q) return true
          const p = row.original
          // AQU-507: match PM username too, so the search box satisfies the
          // "filter by PM" half of the AC without a separate filter control.
          return `${p.name} ${p.orgName ?? ""} ${p.pm?.username ?? ""}`.toLowerCase().includes(q)
        }}
        toolbar={(table) => (
          <span className="ms-auto text-xs tabular-nums text-muted-foreground">
            {table.getFilteredRowModel().rows.length === tableData.length
              ? `${tableData.length}`
              : t("org.orgHome.organizationsPanel.countFraction", {
                  shown: table.getFilteredRowModel().rows.length,
                  total: tableData.length,
                })}
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
          defaultLaneLabel={defaultLaneLabelByProjectId?.get(assignTarget.projectId) ?? ""}
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
