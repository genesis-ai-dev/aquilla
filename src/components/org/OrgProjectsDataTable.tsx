import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { UserPlus, Users, CloudDownload, CloudOff, HardDriveDownload } from "lucide-react"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import {
  downloadProjectOffline,
  removeOfflineProject,
  getOfflineQueueDepth,
  useDownloadProgress,
  useOfflineProjectStatus,
} from "@/lib/offline/download"
import { toast } from "@/components/ui/toast"
import { Spinner } from "@/components/ui/spinner"
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
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TableEmptyState } from "@/components/ui/page"
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { LaneChips } from "./LaneChips"
import { ProjectLaneSubRows } from "./ProjectLaneSubRows"
import { OrgLaneAssignModal } from "./OrgLaneAssignModal"
import { displayLanes, resolveDefaultLaneLabel } from "./project-lanes"
import { isManagedBy } from "./project-pm-filter"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { canOpenAssignUi } from "@/lib/sync/role-policy"

export type OrgProjectRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
  origin?: "member" | "shared"
  isNew?: boolean
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
 * Offline badge for the `name` column — Tauri desktop only, reusing the same
 * `offline_projects` state and i18n keys as ProjectOverview.tsx's header
 * badge (Phase 5). A standalone component (not inline in the `name` column's
 * `cell` closure) so its hooks attach to their own component instance
 * regardless of how react-table/`flexRender` invokes the outer cell function.
 */
function OfflineProjectBadge({ projectId }: { projectId: string }) {
  const { store } = useOfflineStore()
  const { t } = useI18n()
  const status = useOfflineProjectStatus(store, projectId)
  const progress = useDownloadProgress(projectId)

  if (!isTauriRuntime()) return null

  if (status?.status === "ready") {
    return (
      <Badge variant="secondary" className="shrink-0" data-testid="offline-ready-badge">
        <HardDriveDownload className="size-3" aria-hidden />
        {t("org.projectOverview.offlineReadyBadge")}
      </Badge>
    )
  }
  if (status?.status === "downloading") {
    return (
      <Badge variant="outline" className="shrink-0" data-testid="offline-downloading-badge">
        <Spinner className="size-3" />
        {progress
          ? t("org.projectOverview.offlineDownloadingProgress", {
              done: progress.filesDone,
              total: progress.filesTotal,
            })
          : t("org.projectOverview.offlineDownloading")}
      </Badge>
    )
  }
  return null
}

/**
 * "Make available offline" / "Remove offline copy" row-menu items — Tauri
 * desktop only, same handlers/error messages as ProjectOverview.tsx's
 * overflow menu (Phase 5), just surfaced per-row here instead of on the
 * single-project page. Errors go to a toast rather than inline text since a
 * table row has no room for a persistent error message.
 */
function OfflineRowMenuItems({ projectId, jwt }: { projectId: string; jwt: string | null }) {
  const { store } = useOfflineStore()
  const { t } = useI18n()
  const status = useOfflineProjectStatus(store, projectId)

  if (!isTauriRuntime()) return null

  async function handleMakeAvailableOffline() {
    if (!store || !jwt) return
    try {
      await downloadProjectOffline(store, projectId, jwt)
    } catch (e) {
      toast.add({ type: "error", title: e instanceof Error ? e.message : String(e) })
    }
  }

  function handleRemoveOfflineCopy() {
    if (!store) return
    const queueDepth = getOfflineQueueDepth(store, projectId)
    if (queueDepth > 0) {
      toast.add({ type: "error", title: t("org.projectOverview.offlineRemoveBlocked", { count: queueDepth }) })
      return
    }
    const result = removeOfflineProject(store, projectId)
    if (!result.ok && result.reason === "queue-not-empty") {
      // Lost a race with a write that queued between the check above and the
      // removal itself — same message, fresh count.
      toast.add({ type: "error", title: t("org.projectOverview.offlineRemoveBlocked", { count: result.queueDepth }) })
    }
  }

  return (
    <>
      <MenuSeparator />
      {status?.status === "ready" ? (
        <MenuItem onClick={handleRemoveOfflineCopy}>
          <CloudOff className="size-4" />
          {t("org.projectOverview.removeOfflineCopy")}
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() => {
            void handleMakeAvailableOffline()
          }}
          disabled={!jwt || status?.status === "downloading"}
        >
          <CloudDownload className="size-4" />
          {status?.status === "downloading"
            ? t("org.projectOverview.offlineDownloading")
            : t("org.projectOverview.makeAvailableOffline")}
        </MenuItem>
      )}
    </>
  )
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
  emptyAction,
  testId = "org-projects-table",
  layout = "page",
  defaultLaneLabelByProjectId,
  filesByProjectId,
  orgId = null,
  jwt,
  author,
  viewerUsername = null,
  allowSelfAssignment = false,
  assignmentMinRole = ROLE.PROJECT_LEAD,
  callerUserId = null,
  onLanesChanged,
  toolbarLeading,
  toolbarTrailing,
  loading = false,
  loadingLabel,
  searchValue,
  onSearchChange,
  searching = false,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
}: {
  projects: OrgProjectRow[]
  now: number
  showOrg?: boolean
  roleByProjectId?: Map<string, CloudProjectSummary["role"]>
  initialLens?: ProjectLens
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  testId?: string
  /** `page` = panel shell; `embedded` = in-Section admin table chrome. */
  layout?: "page" | "embedded"
  /**
   * AQU-538 §3.2: project → per-file target-language hint for the '' lane chip.
   * AQU-606: only a *fallback* — `resolveDefaultLaneLabel` prefers the project's
   * own `targetLanguage`, which is where migrated projects carry it.
   */
  defaultLaneLabelByProjectId?: Map<string, string>
  /** AQU-538 §3.2: project → its files, for the lane sub-row "Assign…" action. */
  filesByProjectId?: Map<string, { id: string; name: string }[]>
  /** The active org id — threaded to StaffLanePopover / AssignModal. */
  orgId?: number | null
  /** JWT — required to enable assign/staff lane actions. */
  jwt?: string | null
  /** Current username — stamped as the assignment event author. */
  author?: string
  /**
   * AQU-1027: signed-in username, used only to mark the PM column's own row
   * "(you)". Deliberately separate from `author`, which happens to hold the
   * same value but means "who to credit for an assignment event".
   */
  viewerUsername?: string | null
  allowSelfAssignment?: boolean
  assignmentMinRole?: number
  callerUserId?: number | null
  /** Called after an assign/staff lane action, so the parent can refetch the
   * portfolio (per-lane rollups changed). */
  onLanesChanged?: () => void
  /** Extra controls rendered immediately after the search input (e.g. status filter). */
  toolbarLeading?: ReactNode
  /** Extra controls at the end of the toolbar row (e.g. New Project). */
  toolbarTrailing?: ReactNode
  loading?: boolean
  loadingLabel?: string
  searchValue?: string
  onSearchChange?: (value: string) => void
  searching?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
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

  const canAssignProject = useCallback(
    (projectId: string) =>
      Boolean(jwt && author != null) &&
      !embedded &&
      canOpenAssignUi(
        roleByProjectId?.get(projectId)?.level ?? null,
        allowSelfAssignment,
        assignmentMinRole,
      ),
    [jwt, author, embedded, roleByProjectId, allowSelfAssignment, assignmentMinRole],
  )

  const columns = useMemo<ColumnDef<OrgProjectRow>[]>(
    () => {
      const cols: ColumnDef<OrgProjectRow>[] = [
        {
          id: "name",
          accessorFn: (p) => p.name.toLowerCase(),
          header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.project")} />,
          meta: { className: embedded ? "min-w-[12rem]" : "min-w-0" },
          cell: ({ row }) => {
            const p = row.original
            return (
              <span className="flex min-w-0 items-center gap-2">
                <span
                  data-testid="project-table-name"
                  className="min-w-0 truncate font-medium text-foreground"
                >
                  {p.name}
                </span>
                {p.origin === "shared" && (
                  <Badge variant="soft" className="shrink-0" data-testid="project-shared-badge">
                    {t("org.orgHome.statusFilter.shared")}
                  </Badge>
                )}
                {p.isNew && (
                  <Badge className="shrink-0" data-testid="new-shared-badge">
                    {t("org.guestOrgHome.newBadge")}
                  </Badge>
                )}
                {!embedded && <OfflineProjectBadge projectId={p.id} />}
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
          header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.org")} />,
          meta: { className: embedded ? "min-w-[7.5rem] whitespace-nowrap" : "min-w-0 w-[9rem]" },
          cell: ({ row }) =>
            row.original.orgName ? (
              <span
                data-testid="project-table-organization"
                data-org-name={row.original.orgName}
                className="block min-w-0 max-w-full"
              >
                <OrgWithAvatar
                  name={row.original.orgName}
                  size="xs"
                  className="w-full max-w-full"
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
          header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.table.languageHeader")} />,
          meta: { className: embedded ? "min-w-[9rem] whitespace-nowrap" : "min-w-0" },
          cell: ({ row }) => {
            const p = row.original
            return (
              <div data-testid="project-table-languages" className="min-w-0 overflow-hidden">
                <LaneChips
                  projectId={p.id}
                  lanes={displayLanes(p)}
                  defaultLaneLabel={resolveDefaultLaneLabel(p, defaultLaneLabelByProjectId?.get(p.id))}
                  onOverflowClick={embedded ? undefined : () => toggleExpand(p.id)}
                  maxVisible={embedded ? 2 : undefined}
                  className={cn("w-full", embedded && "flex-nowrap")}
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
              title={t("org.orgHome.table.translatedHeaderLabel")}
              className="justify-end"
              data-testid="project-table-translated-header"
            />
          ),
          meta: { align: "right", className: embedded ? "w-[6rem] whitespace-nowrap" : "w-[6.5rem]" },
          cell: ({ row }) => {
            const pct = Math.round(translatedPct(row.original) * 100)
            return (
              <div
                data-testid="project-table-translated-value"
                className="text-right tabular-nums text-muted-foreground"
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
            <DataTableColumnHeader
              column={column}
              title={t("org.orgHome.table.validatedHeaderLabel")}
              className="justify-end"
              data-testid="project-table-validated-header"
            />
          ),
          meta: { align: "right", className: embedded ? "w-[6rem] whitespace-nowrap" : "w-[6.5rem]" },
          cell: ({ row }) => {
            const pct = Math.round(validatedPct(row.original) * 100)
            return (
              <div
                data-testid="project-table-validated-value"
                className="text-right tabular-nums text-muted-foreground"
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
            <DataTableColumnHeader
              column={column}
              title={t("nav.lens.audio")}
              className="justify-end"
              data-testid="project-table-audio-header"
            />
          ),
          meta: { align: "right", className: embedded ? "w-[4.5rem] whitespace-nowrap" : "w-[6.5rem]" },
          cell: ({ row }) => {
            const pct = Math.round(audioPct(row.original) * 100)
            return (
              <div
                data-testid="project-table-audio-value"
                className="text-right tabular-nums text-muted-foreground"
                aria-label={t("org.orgHome.table.audioPctAria", { pct })}
              >
                {pct}%
              </div>
            )
          },
        },
        {
          // AQU-1097: "which units are done" at org scale. Sorts by share
          // done so the projects furthest from finished surface first;
          // projects with nothing to plan sort last rather than reading as 0%.
          id: "units",
          accessorFn: (p) =>
            missingLast(p.unitsTotal ? (p.unitsDone ?? 0) / p.unitsTotal : undefined),
          sortUndefined: SORT_MISSING_LAST,
          header: ({ column }) => (
            <DataTableColumnHeader
              column={column}
              title={t("org.orgProjectsDataTable.unitsColumn")}
              className="justify-end"
              data-testid="project-table-units-header"
            />
          ),
          meta: { align: "right", className: embedded ? "w-[5rem] whitespace-nowrap" : "w-[7rem]" },
          cell: ({ row }) => {
            const p = row.original
            const total = p.unitsTotal ?? 0
            // A project with no plannable files has nothing to say here. An
            // em dash is honest; "0 of 0" reads like a failure.
            if (total === 0) {
              return (
                <div data-testid="project-table-units-value" className="text-right text-muted-foreground">
                  —
                </div>
              )
            }
            const done = p.unitsDone ?? 0
            const overdue = p.unitsOverdue ?? 0
            return (
              <div
                data-testid="project-table-units-value"
                data-units-overdue={overdue > 0 ? "true" : undefined}
                className="flex items-center justify-end gap-1.5 text-right tabular-nums text-muted-foreground"
                aria-label={t("org.orgProjectsDataTable.unitsDoneAria", { done, total })}
              >
                <span>{t("org.orgProjectsDataTable.unitsDoneValue", { done, total })}</span>
                {overdue > 0 && (
                  <AppTooltip content={t("org.orgProjectsDataTable.unitsOverdueTooltip", { count: overdue })}>
                    <span
                      data-testid="project-table-units-overdue"
                      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/12 px-1 text-[10px] font-semibold text-destructive"
                    >
                      {overdue}
                    </span>
                  </AppTooltip>
                )}
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
            header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.roleLabel")} />,
            meta: { className: "w-[7.5rem] whitespace-nowrap" },
            cell: ({ row }) => {
              const name = roleByProjectId?.get(row.original.id)?.name
              if (!name) {
                return <span className="text-sm text-muted-foreground">—</span>
              }
              return (
                <RoleLabel name={name} />
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
                return <span className="text-sm text-muted-foreground">{t("org.projectOverview.unassigned")}</span>
              }
              return (
                <UsernameWithAvatar
                  username={username}
                  size="xs"
                  nameClassName="font-normal"
                >
                  {/* AQU-1027: lets a PM spot their own projects while
                      scrolling the unfiltered list. Reuses the existing
                      "(you)" string rather than minting a second one. */}
                  {isManagedBy(row.original, viewerUsername) && (
                    <span
                      data-testid="project-pm-you"
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {t("editor.validation.you")}
                    </span>
                  )}
                </UsernameWithAvatar>
              )
            },
          },
        )
      }

      cols.push({
        id: "status",
        accessorFn: (p) => attentionRank(p, tableNow),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.projectsPanel.statusLabel")} />,
        meta: { className: embedded ? "w-[6.75rem] whitespace-nowrap" : "w-[9.5rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const p = row.original
          return (
            <span data-testid="project-table-deadline-status" className="block min-w-0 overflow-hidden">
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
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgProjectsDataTable.updatedColumn")} />,
        meta: { className: "w-[7.5rem] whitespace-nowrap", ...(embedded ? { hidden: true } : {}) },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.lastEditAt}
            label={t("org.orgProjectsDataTable.updatedColumn")}
            className="text-sm text-muted-foreground"
          />
        ),
      })

      if (!embedded) {
        cols.push({
          id: "actions",
          enableSorting: false,
          header: () => <span className="sr-only">{t("org.orgProjectsDataTable.actionsColumnSrOnly")}</span>,
          meta: { align: "right" as const, className: "w-10" },
          cell: ({ row }) => {
            const p = row.original
            return (
              <DataTableRowActionsButton
                label={t("org.orgProjectsDataTable.moreActionsAriaLabel", { name: p.name })}
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
      viewerUsername,
      t,
    ],
  )

  const colSpan = columns.filter((c) => !(c.meta as { hidden?: boolean } | undefined)?.hidden).length

  const assignProject = assignTarget
    ? projects.find((p) => p.id === assignTarget.projectId) ?? null
    : null

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col">
      <DataTable
        key={`${layout}:${initialLens}`}
        columns={columns}
        data={tableData}
        getRowId={(p) => p.id}
        getRowAttributes={(p) => ({
          "data-project-id": p.id,
          ...(p.origin === "shared" ? { "data-origin": "shared" } : {}),
        })}
        rowClassName="group"
        onRowClick={(p) => navigate(`/projects/${p.id}`)}
        initialSorting={[...lensToSorting(initialLens)]}
        searchPlaceholder="Search projects…"
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        searching={searching}
        fillHeight
        loading={loading}
        loadingLabel={loadingLabel}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        loadingMore={loadingMore}
        globalFilterFn={
          onSearchChange
            ? undefined
            : (row, _columnId, filterValue) => {
          const q = String(filterValue).trim().toLowerCase()
          if (!q) return true
          const p = row.original
          // AQU-507: match PM username too, so the search box satisfies the
          // "filter by PM" half of the AC without a separate filter control.
          return `${p.name} ${p.orgName ?? ""} ${p.pm?.username ?? ""}`.toLowerCase().includes(q)
        }
        }
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
                    defaultLaneLabel={resolveDefaultLaneLabel(p, defaultLaneLabelByProjectId?.get(p.id))}
                    colSpan={colSpan}
                    orgId={orgId}
                    onAssign={
                      canAssignProject(p.id)
                        ? (lane) => setAssignTarget({ projectId: p.id, lane })
                        : undefined
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
                  {canAssignProject(p.id) && (
                    <MenuItem
                      onClick={() => setAssignTarget({ projectId: p.id, lane: "" })}
                    >
                      <UserPlus className="size-4" />
                      {t("dialog.assign.title")}
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => navigate(`/project/${p.id}/settings/members`, {
                    state: { backgroundLocation: location, projectSettingsModalDepth: 1 },
                  })}>
                    <Users className="size-4" />
                    {t("org.teamDetail.addMemberButton")}
                  </MenuItem>
                  <OfflineRowMenuItems projectId={p.id} jwt={jwt ?? null} />
                </>
              )
        }
        emptyState={(table) => {
          const search = (searchValue ?? String(table.getState().globalFilter ?? "")).trim()
          if (search) {
            return (
              <div className="flex flex-col items-center gap-3 py-10">
                <p className="text-center text-sm text-muted-foreground">
                  {t("org.orgProjectsDataTable.noSearchMatch")}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    table.setGlobalFilter("")
                    onSearchChange?.("")
                  }}
                >
                  {t("common.clear")}
                </Button>
              </div>
            )
          }
          return (
            <TableEmptyState
              icon={NAV_PAGE_ICONS.projects}
              title={emptyTitle}
              description={emptyDescription}
              action={emptyAction}
            />
          )
        }}
        testId={testId}
        className={
          embedded
            ? cn(
                ADMIN_TABLE_CLASS,
                // Scroll wide columns inside the Section card instead of
                // table-fixed shrinking (and clipping) Status off the edge.
                "mx-0 min-w-0 w-full",
                "[&_[data-slot=table-container]]:min-w-0 [&_[data-slot=table-container]]:overflow-visible",
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
          defaultLaneLabel={resolveDefaultLaneLabel(
            assignProject,
            defaultLaneLabelByProjectId?.get(assignTarget.projectId),
          )}
          files={filesByProjectId?.get(assignTarget.projectId) ?? []}
          roleLevel={roleByProjectId?.get(assignTarget.projectId)?.level ?? 0}
          jwt={jwt}
          author={author}
          allowSelfAssignment={allowSelfAssignment}
          assignmentMinRole={assignmentMinRole}
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
