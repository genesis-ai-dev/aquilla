import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { UserPlus, Users } from "lucide-react"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import {
  attentionRank,
  audioPct,
  translatedPct,
  validatedPct,
  type PortfolioProject,
} from "@/lib/frontier/portfolio"
import { ROLE } from "@/lib/frontier/roles"
import { portfolioAttentionReasons } from "@/lib/project-status"
import { ProjectStatus } from "@/components/ProjectStatus"
import {
  ADMIN_TABLE_CLASS,
  ADMIN_TABLE_PANEL_CLASS,
} from "@/components/admin/shared"
import { RoleLabel } from "@/components/RoleLabel"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { DataTable, DataTableColumnHeader, DataTableRowActionsButton } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { MenuItem } from "@/components/ui/menu-parts"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { LaneChips } from "./LaneChips"
import { ProjectLaneSubRows } from "./ProjectLaneSubRows"
import { OrgLaneAssignModal } from "./OrgLaneAssignModal"
import { displayLanes } from "./project-lanes"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { cn } from "@/lib/utils"

export type OrgProjectRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
}

type ProjectLens = "recent" | "attention" | "least-translated" | "most-progress" | "name" | "pm"

function lensToSorting(lens: ProjectLens) {
  switch (lens) {
    case "recent":
      return [{ id: "edited", desc: true }] as const
    case "attention":
      return [{ id: "status", desc: true }] as const
    case "least-translated":
      return [{ id: "translated", desc: false }] as const
    case "most-progress":
      return [{ id: "translated", desc: true }] as const
    case "name":
      return [{ id: "name", desc: false }] as const
    case "pm":
      // AQU-507: ascending by PM username; unassigned stays last via
      // sortUndefined: "last" on the column (direction-immune).
      return [{ id: "pm", desc: false }] as const
  }
}

/**
 * Portfolio projects DataTable — same chrome as the admin console.
 *
 * - `page`: standalone card shell (org Projects list).
 * - `embedded`: in-card borderless table for Section panels (all-orgs overview).
 */
export function OrgProjectsDataTable({
  projects,
  now,
  showOrg = false,
  roleByProjectId,
  initialLens = "recent",
  emptyTitle = "No projects yet.",
  emptyDescription,
  testId = "org-projects-table",
  layout = "page",
  defaultLaneLabelByProjectId,
  filesByProjectId,
  orgId = null,
  jwt,
  author,
  allowSelfAssignment = false,
  callerUserId = null,
  onLanesChanged,
  toolbarLeading,
  toolbarTrailing,
}: {
  projects: OrgProjectRow[]
  now: number
  showOrg?: boolean
  roleByProjectId?: Map<string, CloudProjectSummary["role"]>
  initialLens?: ProjectLens
  emptyTitle?: string
  emptyDescription?: string
  testId?: string
  /** `page` = panel shell; `embedded` = in-Section admin table chrome. */
  layout?: "page" | "embedded"
  /** AQU-538 §3.2: project → default target language, labeling the '' lane chip. */
  defaultLaneLabelByProjectId?: Map<string, string>
  /** AQU-538 §3.2: project → its files, for the lane sub-row "Assign…" action. */
  filesByProjectId?: Map<string, { id: string; name: string }[]>
  /** The active org id — threaded to StaffLanePopover / AssignModal. */
  orgId?: number | null
  /** JWT — required to enable assign/staff lane actions. */
  jwt?: string | null
  /** Current username — stamped as the assignment event author. */
  author?: string
  allowSelfAssignment?: boolean
  callerUserId?: number | null
  /** Called after an assign/staff lane action, so the parent can refetch the
   * portfolio (per-lane rollups changed). */
  onLanesChanged?: () => void
  /** Extra controls rendered immediately after the search input (e.g. status filter). */
  toolbarLeading?: ReactNode
  /** Extra controls at the end of the toolbar row (e.g. New Project). */
  toolbarTrailing?: ReactNode
}) {
  const navigate = useNavigate()
  const [tableNow] = useState(() => now)
  // AQU-538 §3.2: which project rows are expanded into their per-lane detail.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // The lane "Assign…" currently open (project + lane), or null.
  const [assignTarget, setAssignTarget] = useState<{ projectId: string; lane: string } | null>(null)
  const embedded = layout === "embedded"

  const toggleExpand = useCallback((projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }, [])

  const tableData = useMemo(() => projects, [projects])

  const canAssign = Boolean(jwt && author != null) && !embedded

  const columns = useMemo<ColumnDef<OrgProjectRow>[]>(
    () => {
      const cols: ColumnDef<OrgProjectRow>[] = [
        {
          id: "name",
          accessorFn: (p) => p.name.toLowerCase(),
          header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
          meta: { className: "min-w-0" },
          cell: ({ row }) => {
            const p = row.original
            return (
              <span
                data-testid="project-table-name"
                className="block min-w-0 truncate font-medium text-foreground"
              >
                {p.name}
              </span>
            )
          },
        },
      ]

      if (showOrg) {
        cols.push({
          id: "org",
          accessorFn: (p) => missingLast((p.orgName ?? "").toLowerCase()),
          sortUndefined: SORT_MISSING_LAST,
          header: ({ column }) => <DataTableColumnHeader column={column} title="Org" />,
          meta: { className: "min-w-0 w-[9rem]" },
          cell: ({ row }) =>
            row.original.orgName ? (
              <span
                data-testid="project-table-organization"
                data-org-name={row.original.orgName}
              >
                <OrgWithAvatar
                  name={row.original.orgName}
                  size="xs"
                  nameClassName="font-normal"
                />
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        })
      }

      cols.push(
        {
          id: "languages",
          enableSorting: false,
          header: ({ column }) => <DataTableColumnHeader column={column} title="Language" />,
          meta: { className: "min-w-0" },
          cell: ({ row }) => {
            const p = row.original
            return (
              <div data-testid="project-table-languages" className="min-w-0 overflow-hidden">
                <LaneChips
                  projectId={p.id}
                  lanes={displayLanes(p)}
                  defaultLaneLabel={defaultLaneLabelByProjectId?.get(p.id) ?? ""}
                  onOverflowClick={embedded ? undefined : () => toggleExpand(p.id)}
                  maxVisible={embedded ? 2 : undefined}
                  className="w-full"
                />
              </div>
            )
          },
        },
        {
          id: "translated",
          accessorFn: (p) => translatedPct(p),
          header: ({ column }) => (
            <DataTableColumnHeader
              column={column}
              title="Translated"
              className="justify-end"
              data-testid="project-table-translated-header"
            />
          ),
          meta: { align: "right", className: "w-[6.5rem]" },
          cell: ({ row }) => {
            const pct = Math.round(translatedPct(row.original) * 100)
            return (
              <div
                data-testid="project-table-translated-value"
                className="text-right tabular-nums text-muted-foreground"
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
            <DataTableColumnHeader
              column={column}
              title="Validated"
              className="justify-end"
              data-testid="project-table-validated-header"
            />
          ),
          meta: { align: "right", className: "w-[6.5rem]" },
          cell: ({ row }) => {
            const pct = Math.round(validatedPct(row.original) * 100)
            return (
              <div
                data-testid="project-table-validated-value"
                className="text-right tabular-nums text-muted-foreground"
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
            <DataTableColumnHeader
              column={column}
              title="Audio"
              className="justify-end"
              data-testid="project-table-audio-header"
            />
          ),
          meta: { align: "right", className: "w-[6.5rem]" },
          cell: ({ row }) => {
            const pct = Math.round(audioPct(row.original) * 100)
            return (
              <div
                data-testid="project-table-audio-value"
                className="text-right tabular-nums text-muted-foreground"
                aria-label={`${pct}% audio`}
              >
                {pct}%
              </div>
            )
          },
        },
      )

      if (!embedded) {
        cols.push(
          {
            id: "role",
            accessorFn: (p) => roleByProjectId?.get(p.id)?.name ?? "",
            enableSorting: false,
            header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
            meta: { className: "w-[7.5rem] whitespace-nowrap" },
            cell: ({ row }) => {
              const name = roleByProjectId?.get(row.original.id)?.name
              if (!name) {
                return <span className="text-sm text-muted-foreground">—</span>
              }
              return (
                <span className="text-sm text-foreground">
                  <RoleLabel name={name} />
                </span>
              )
            },
          },
          {
            // AQU-507: designated Project Manager. Unassigned sorts last in both
            // directions via sortUndefined (direction-immune).
            id: "pm",
            accessorFn: (p) => missingLast(p.pm?.username?.toLowerCase()),
            sortUndefined: SORT_MISSING_LAST,
            header: ({ column }) => <DataTableColumnHeader column={column} title="PM" />,
            meta: { className: "min-w-0 w-[9rem]" },
            cell: ({ row }) => {
              const username = row.original.pm?.username
              if (!username) {
                return <span className="text-sm text-muted-foreground">Unassigned</span>
              }
              return (
                <UsernameWithAvatar
                  username={username}
                  size="xs"
                  nameClassName="font-normal"
                />
              )
            },
          },
        )
      }

      cols.push({
        id: "status",
        accessorFn: (p) => attentionRank(p, tableNow),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        meta: { className: "w-[9.5rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const p = row.original
          return (
            <span data-testid="project-table-deadline-status">
              <ProjectStatus
                archived={false}
                reasons={portfolioAttentionReasons(p, tableNow)}
                deadlineAt={p.deadlineAt}
              />
            </span>
          )
        },
      })

      cols.push({
        id: "edited",
        accessorFn: (p) => missingLast(p.lastEditAt ?? undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
        meta: { className: "w-[7.5rem] whitespace-nowrap", ...(embedded ? { hidden: true } : {}) },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.lastEditAt}
            label="Updated"
            className="text-sm text-muted-foreground"
          />
        ),
      })

      if (!embedded) {
        cols.push({
          id: "actions",
          enableSorting: false,
          header: () => <span className="sr-only">Project actions</span>,
          meta: { align: "right" as const, className: "w-10" },
          cell: ({ row }) => {
            const p = row.original
            return (
              <DataTableRowActionsButton
                label={`More actions for ${p.name}`}
                data-testid={`project-row-actions-${p.id}`}
                revealOnHover
              />
            )
          },
        })
      }

      return cols
    },
    [
      roleByProjectId,
      showOrg,
      tableNow,
      toggleExpand,
      defaultLaneLabelByProjectId,
      embedded,
    ],
  )

  const colSpan = columns.filter((c) => !(c.meta as { hidden?: boolean } | undefined)?.hidden).length

  const assignProject = assignTarget
    ? projects.find((p) => p.id === assignTarget.projectId) ?? null
    : null

  return (
    <div className={cn(embedded && "flex min-h-0 flex-1 flex-col")}>
      <DataTable
        key={`${layout}:${initialLens}`}
        columns={columns}
        data={tableData}
        getRowId={(p) => p.id}
        getRowAttributes={(p) => ({ "data-project-id": p.id })}
        rowClassName="group"
        onRowClick={(p) => navigate(`/projects/${p.id}`)}
        initialSorting={[...lensToSorting(initialLens)]}
        searchPlaceholder="Search projects…"
        fillHeight={embedded}
        globalFilterFn={(row, _columnId, filterValue) => {
          const q = String(filterValue).trim().toLowerCase()
          if (!q) return true
          const p = row.original
          // AQU-507: match PM username too, so the search box satisfies the
          // "filter by PM" half of the AC without a separate filter control.
          return `${p.name} ${p.orgName ?? ""} ${p.pm?.username ?? ""}`.toLowerCase().includes(q)
        }}
        toolbar={
          <>
            {toolbarLeading}
            {toolbarTrailing}
          </>
        }
        renderSubRow={
          embedded
            ? undefined
            : (p) =>
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
        renderRowMenuItems={
          embedded
            ? undefined
            : (p) => (
                <>
                  {canAssign && (
                    <MenuItem
                      onClick={() => setAssignTarget({ projectId: p.id, lane: "" })}
                    >
                      <UserPlus className="size-4" />
                      Assign work
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => navigate(`/project/${p.id}/settings/members`)}>
                    <Users className="size-4" />
                    Add member
                  </MenuItem>
                </>
              )
        }
        emptyState={(table) => {
          const search = String(table.getState().globalFilter ?? "").trim()
          if (search) {
            return (
              <div className="flex flex-col items-center gap-3 py-10">
                <p className="text-center text-sm text-muted-foreground">
                  No projects match your search.
                </p>
                <Button variant="outline" onClick={() => table.setGlobalFilter("")}>
                  Clear
                </Button>
              </div>
            )
          }
          return (
            <EmptyState
              variant="inline"
              className="flex-none py-12"
              icon={NAV_PAGE_ICONS.projects}
              title={emptyTitle}
              description={emptyDescription}
            />
          )
        }}
        testId={testId}
        className={
          embedded
            ? cn(
                ADMIN_TABLE_CLASS,
                // Same as orgs card: kill -mx-2 bleed + nested table-container
                // scrollport so only one vertical scrollbar shows on the shell.
                "mx-0 [&_[data-slot=table-container]]:overflow-hidden",
              )
            : ADMIN_TABLE_PANEL_CLASS
        }
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
    </div>
  )
}
