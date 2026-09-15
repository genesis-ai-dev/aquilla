import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useParams, useNavigate, useLocation, Link } from "react-router-dom"
import { MoreHorizontal, Download, SlidersHorizontal, Archive, PlayCircle, PauseCircle, Settings, Pencil } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { AppTooltip } from "@/components/ui/tooltip"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { ExpandableName } from "@/components/ui/expandable-name"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { Button, buttonVariants } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { orgProjectsPath, projectSettingsPath } from "@/lib/navigation/org-paths"
import { Spinner } from "@/components/ui/spinner"
import { useOpenWorkspace } from "@/hooks/useOpenWorkspace"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import { useNavHistoryTitle } from "@/context/NavHistoryContext"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { archiveProjectRemote, unarchiveProjectRemote } from "@/lib/sync/archive"
import { setProjectDeadline, setProjectPm } from "@/lib/sync/cloud-projects"
import { markProjectOpened } from "@/lib/frontier/opened-shared-store"
import { useProjectLifecycle } from "@/hooks/useProjectLifecycle"
import { InactiveProjectBanner } from "@/components/InactiveProjectBanner"
import { downloadProjectBundle } from "@/lib/sync/export-bundle"
import { downloadImportedOriginal, downloadImportedOriginalsZip } from "@/lib/file-original-download"
import { AssignWork } from "./AssignWork"
import { MemberActivityPanel } from "./MemberActivityPanel"
import { ProjectAutopilotPanel } from "./ProjectAutopilotPanel"
import { isAutopilotVisible } from "@/lib/features/flags"
import { getPortfolio, translatedPct, validatedPct, aiDraftedPct, audioPct, audioValidatedPct, audioValidatedOfRecordedPct, recordedMinutes, deadlineStatus, laneTranslatedPct, laneValidatedPct, type PortfolioProject, type PortfolioLane } from "@/lib/frontier/portfolio"
import { OverviewLaneTable } from "./OverviewLaneTable"
import { downloadBlob } from "@/lib/export/export-service"
import { PlanBoard } from "./plan/PlanBoard"
import { PlanInspector } from "./plan/PlanInspector"
import { RightSidebarPanel } from "@/components/RightSidebarPanel"
import { useIsLgUp } from "@/components/AppShell"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { planHasAudio } from "@/lib/plan/plan-status"
import { useProjectPlan } from "@/hooks/useProjectPlan"
import { planUnitId, planUnitLabel, type PlanUnit } from "@/lib/plan/plan-status"
import { planRowsToCsv, planCsvFilename } from "@/lib/progress/plan-csv"
import { fetchProjectFiles, type FileSummary } from "@/lib/sync/cells-read"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { getProjectAssignments, type AssigneeWorkload } from "@/lib/sync/assignments"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ROLE } from "@/lib/frontier/roles"
import {
  SectionVisibilityBadge,
  SectionVisibilityGate,
  sectionTintClass,
} from "./SectionVisibilityBadge"
import { Badge } from "@/components/ui/badge"
import { ProjectDeadlineStatuses, ProjectStatusChip } from "@/components/ProjectStatus"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DatePicker, dateToDeadlineString, deadlineStringToDate } from "@/components/ui/date-picker"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  STAT_WIDGETS,
  loadHiddenStats,
  saveHiddenStats,
  toggleHiddenStat,
  type StatKey,
} from "@/lib/metrics/hidden-stats"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingTemplate } from "@/components/ui/loading-overlay"
import { useT } from "@/lib/i18n/I18nProvider"
import { bidiIsolate } from "@/lib/i18n/format"
import { SegmentTabs } from "@/components/ui/tabs"
import { SignedOutWorkspace } from "./SignedOutWorkspace"


function ProjectOverviewSkeleton() {
  return (
    <div className="max-w-5xl space-y-4">
      <div className="rounded-lg border bg-card shadow-sm p-6 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-20" />
        <div className="flex items-start gap-4 pt-2">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-48" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-56" />
          </div>
        </div>
      </div>
      <div className="rounded-lg border bg-card shadow-sm p-5 space-y-4">
        <Skeleton className="h-3 w-20" />
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-24 rounded-lg" />
          ))}
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-2.5 w-full rounded-full" />
          ))}
        </div>
      </div>
      <div className="rounded-lg border bg-card shadow-sm p-5 space-y-3">
        <Skeleton className="h-3 w-16" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-1.5 flex-1 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-card shadow-sm p-5 space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-40" />
      </div>
    </div>
  )
}

// ── Status chip ──────────────────────────────────────────────────────────────

type ProjectStatus = "on-track" | "due-soon" | "overdue" | "no-deadline"

/**
 * Derive a manager-facing project status from deadline + translation progress.
 * Thresholds:
 *   "overdue"  — deadline is in the past
 *   "due-soon" — deadline is within the next 7 days
 *   "on-track" — deadline is further out, or no deadline but translation > 0
 *   "no-deadline" — no deadline and no meaningful progress
 */
export function deriveProjectStatus(
  p: PortfolioProject | null,
  now: number,
): ProjectStatus {
  if (!p) return "no-deadline"
  const ds = deadlineStatus(p, now)
  if (ds === "overdue") return "overdue"
  if (ds === "soon") return "due-soon"
  if (ds === "ok") return "on-track"
  // No deadline
  return "no-deadline"
}

function StatusChip({ status }: { status: ProjectStatus }) {
  // Overdue / due-soon live only next to the deadline field — avoid duplicating them on the title.
  if (status === "no-deadline" || status === "overdue" || status === "due-soon") return null
  return <ProjectStatusChip kind="on-track" testId="status-chip" />
}

// ── Deadline chip ─────────────────────────────────────────────────────────────

function DeadlineChip({ status }: { status: "overdue" | "soon" | "ok" | null }) {
  // On-track lives only next to the title — avoid duplicating it on the deadline.
  return <ProjectDeadlineStatuses deadline={status} testId="status-chip" />
}

/** Icon-only edit control for a header meta field (PM, deadline). */
function MetaFieldEditButton({
  label,
  disabled,
  testId,
  onClick,
}: {
  label: string
  disabled: boolean
  testId?: string
  onClick: () => void
}) {
  return (
    <AppTooltip content={label}>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
      >
        <Pencil />
      </Button>
    </AppTooltip>
  )
}

// ── Stat tiles (big %) ────────────────────────────────────────────────────────

function StatTile({ label, pct, colorClass, tooltip }: {
  label: string
  pct: number
  colorClass: string
  tooltip?: string
}) {
  const tile = (
    <div className="flex flex-col items-center rounded-lg bg-muted/40 px-5 py-3 text-center">
      <p className={`text-2xl font-bold tabular-nums ${colorClass}`}>{`${Math.round(pct * 100)}%`}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
  return tooltip ? <AppTooltip content={tooltip}>{tile}</AppTooltip> : tile
}

// ── Lane filter tabs (AQU-538 §3.3) ───────────────────────────────────────────
// SegmentTabs needs a non-empty string value; map null/"All" and the default
// lane ('' on the portfolio) to sentinels so triggers stay unique.

const LANE_TAB_ALL = "__all__"
const LANE_TAB_DEFAULT = "__default__"
/**
 * AQU-656: rows the imported-originals card shows before "Show more" /
 * "Show all" kick in. Also the batch size each "Show more" reveals.
 */
const ORIGINALS_PAGE_SIZE = 5

function laneTagToTab(tag: string | null): string {
  if (tag === null) return LANE_TAB_ALL
  if (tag === "") return LANE_TAB_DEFAULT
  return tag
}

function tabToLaneTag(tab: string): string | null {
  if (tab === LANE_TAB_ALL) return null
  if (tab === LANE_TAB_DEFAULT) return ""
  return tab
}

// ── Stat bar ──────────────────────────────────────────────────────────────────

function StatBar({ label, value, total, fillClass, suffix }: {
  label: string
  value: number
  total: number
  fillClass: string
  suffix?: string
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-1 items-center gap-2">
        <span className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
          <span className={`block h-full rounded-full transition-all ${fillClass}`} style={{ width: `${pct}%` }} />
        </span>
        <span className="w-20 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </div>
      <span className="w-28 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground/70">
        {value}/{total}{suffix ? ` ${suffix}` : ""}
      </span>
    </div>
  )
}

// ── Per-file mini-bars ────────────────────────────────────────────────────────


// ── Chapter/verse rollup (AQU-493) ───────────────────────────────────────────








// ── Main component ────────────────────────────────────────────────────────────

export function ProjectOverview() {
  const t = useT()
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // AQU-737: the workspace is a lazy route; surface the load on the Open project
  // button so it spins + disables instead of sitting idle and re-clickable.
  // `openingOverlay` blocks the rest of the page while the open is in flight.
  const { open: openWorkspace, isPending: openPending, overlay: openingOverlay } = useOpenWorkspace()
  const { project, status, refresh, pm, roleLevel } = useProject(id)
  useNavHistoryTitle(project?.name)
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  // AQU-507: candidate PMs = the project's effective members. Only fetched for
  // maintainer+ (the only role that can assign a PM); viewers never trigger the
  // roster read.
  const canManagePm = (project?.syncRole?.level ?? 0) >= 600
  const { members: pmCandidates } = useProjectMembers(canManagePm ? id : null)
  const { activeOrgId, refreshAccessibleProjects } = useActiveOrg()

  // AQU-696: landing on a project's overview counts as "opening" it — this is
  // the page a shared-projects row links to. Recording it here clears the
  // "New" badge for that user, persisted in localStorage across sessions.
  // Keyed on the session username so it survives sign-out (unlike the IDB
  // project index, which is wiped on logout/account switch).
  useEffect(() => {
    const uname = session?.username
    if (uname && id) markProjectOpened(uname, id)
  }, [session?.username, id])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [audio, setAudio] = useState<PortfolioProject | null>(null)
  const [files, setFiles] = useState<FileSummary[]>([])
  // fileId → display name for the autopilot panel, which knows runs by file id
  // only (its rollup comes from the run table, not the file list).
  const autopilotFileNames = useMemo(
    () => new Map(files.map((f) => [f.fileId, f.name])),
    [files],
  )
  // AQU-656: originals live on `file_source_blobs`, not the plan. The files
  // card this used to hang off was replaced by PlanBoard (AQU-1092), so the
  // PM download gallery is this compact list — only files that have a blob.
  const originalFiles = useMemo(
    () => files.filter((f) => f.hasOriginalSource),
    [files],
  )
  // The originals list starts capped at ORIGINALS_PAGE_SIZE rows; "Show more"
  // grows it one page at a time, "Show all" expands it outright, and "Show
  // fewer" collapses it back to the first page.
  const [originalsShown, setOriginalsShown] = useState(ORIGINALS_PAGE_SIZE)
  const visibleOriginals = originalFiles.slice(0, originalsShown)
  const hiddenOriginalsCount = originalFiles.length - visibleOriginals.length
  const [deadlineDialogOpen, setDeadlineDialogOpen] = useState(false)
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  // AQU-507: PM assignment dialog. `pmSelection` holds the picker value (a
  // stringified userId, or "" for unassigned) while the dialog is open.
  const [pmDialogOpen, setPmDialogOpen] = useState(false)
  const [pmSelection, setPmSelection] = useState<string>("")
  const [workload, setWorkload] = useState<AssigneeWorkload[]>([])

  // AQU-538 §3.3: the lane filter tab selection. `null` = "All" — today's
  // cross-lane behavior, byte-identical (StatTiles read the PortfolioProject
  // scalars, file drill-down reads with no lane param). A non-null value is a
  // real lane tag ('' = the default lane) selected from the tab row; the tiles
  // recompute from that lane's PortfolioLane and the drill-down re-reads with
  // `?lane=`.
  const [selectedLaneTag, setSelectedLaneTag] = useState<string | null>(null)
  // AQU-593: per-user preference for which Progress-card stat widgets to hide.
  // Client-side only (localStorage); toggling never touches project data.
  const [hiddenStats, setHiddenStats] = useState<Set<StatKey>>(() => loadHiddenStats())
  const toggleStat = useCallback((key: StatKey) => {
    setHiddenStats((prev) => {
      const next = toggleHiddenStat(prev, key)
      saveHiddenStats(next)
      return next
    })
  }, [])
  // The lane passed to the per-file progress reads. "All" (null) and the
  // default lane tab both map to '' server-side (the default lane == the
  // no-param request), so the drill-down only ever diverges for a selected
  // non-default lane.

  // AQU-498: which teammate's activity detail is expanded in the Team card
  // (null = none selected). Username, not userId, since that's the events
  // log's author key (see MemberActivityPanel's doc comment).
  //
  // SWARM-TODO(AQU-498): selection is scoped to `workload` (assignees with at
  // least one open assignment) — reusing the Team card's existing, already
  // memberProgressViewMinRole-gated roster rather than the project's full
  // member list (MembersTab), which is gated by the INDEPENDENT
  // rosterViewMinRole floor (AQU-485). A member with zero open assignments
  // currently has no row to click here even though they may have historical
  // activity. True vertical slice for now; widening selection to the full
  // roster needs either (a) accepting the roster-floor dependency (a caller
  // could then see progress without roster access, or vice versa — a real
  // permission-composition question), or (b) a project-scoped "list authors
  // who have ever committed an event" endpoint independent of both floors.
  const [selectedMemberUsername, setSelectedMemberUsername] = useState<string | null>(null)

  // AQU-500: transient "copied" feedback for the CSV-export control, mirroring
  // the copy-affordance pattern used elsewhere (e.g. ChatMarkdown's code-block
  // copy button).

  // AQU-493/AQU-517: compact progress rollup, lazily fetched per file on
  // first expand. `undefined` = not yet fetched; loaded values choose between
  // canonical book/chapter rows, flat section rows, or a true no-structure note.

  // AQU-474: project-only invitees (direct project_members grant, no org
  // membership) have `activeOrgId == null` or an org that doesn't include this
  // project's org. The portfolio endpoint is org-scoped, so fall back to the
  // project's own (server-verified) orgId when it differs from the active
  // org — `useProject` already gatekept access, so any orgId it returns is
  // one this user can legitimately query the portfolio for.
  const portfolioOrgId = activeOrgId ?? project?.orgId ?? null

  // AQU-486: per-section visibility chrome. The roster + team-progress floors
  // come from AQU-485's org settings; `projectRoleLevel` (not orgRoleLevel)
  // is what gates viewing here per useOrgSettings' AD-12 max-wins contract —
  // a project-only invitee's project.syncRole can exceed their (absent) org
  // role. Editing the floor is still an org-role (owner-only) action, so
  // canEditVisibility below intentionally reads the org role, not the
  // project role.
  const projectRoleLevel = project?.syncRole?.level ?? null
  const orgSettings = useOrgSettings(portfolioOrgId, projectRoleLevel, projectRoleLevel)
  const canEditVisibility = canEditRosterProgressFloor(projectRoleLevel)

  const loadRow = useCallback(async () => {
    if (!jwt || portfolioOrgId == null) return
    try {
      const list = await getPortfolio(jwt, portfolioOrgId)
      setAudio(list.find((p) => p.id === id) ?? null)
    } catch {
      setAudio(null)
    }
  }, [jwt, portfolioOrgId, id])

  useEffect(() => {
    void loadRow()
  }, [loadRow])

  // Only redirect when the user genuinely has no access to this project.
  // `useProject` is server-verified per-project (not org-scoped): a
  // project-only invitee (no org membership, or org mismatch) still resolves
  // to "ready" here when they hold a direct grant. Redirecting on org
  // mismatch alone (pre-AQU-474 behavior) sent guests right back to "/".
  useEffect(() => {
    // AQU-346: "forbidden" (access revoked) leaves the overview the same way
    // a missing project does — back to the dashboard.
    if (status === "not-found" || status === "forbidden") {
      navigate("/", { replace: true })
    }
  }, [status, navigate])

  // Load per-project assignment roster for the Team card (maintainer+)
  // AQU-495: extracted into a callback so a fresh assignment (onAssigned) can
  // revalidate the workload list live, not only on mount — the walkthrough bug
  // was "No open assignments in this project yet." lingering until manual reload.
  const loadWorkload = useCallback(async () => {
    if (!jwt || !id) return
    try {
      setWorkload(await getProjectAssignments(jwt, id))
    } catch {
      setWorkload([])
    }
  }, [jwt, id])

  useEffect(() => {
    void loadWorkload()
  }, [loadWorkload])

  // AQU-495: after a successful assign, refresh BOTH the portfolio row and the
  // open-assignments workload list so the Team card updates without a reload.
  const handleAssigned = useCallback(async () => {
    await Promise.all([loadRow(), loadWorkload()])
  }, [loadRow, loadWorkload])

  // Per-file rollups
  const firstFileId = project?.files[0]?.id ?? null
  useEffect(() => {
    if (!jwt || !id || !firstFileId) { setFiles([]); return }
    let cancelled = false
    fetchSyncToken(jwt, id, firstFileId, { projectName: project?.name })
      .then((tok) => fetchProjectFiles(id, tok.token))
      .then((rows) => { if (!cancelled) setFiles(rows) })
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [jwt, id, firstFileId, project?.name])

  // AQU-498: token minter for MemberActivityPanel — same project-scoped
  // sync-token mint used for the per-file rollups above (verifyTokenForProject
  // only checks projectId, so any file-scoped token in this project works).
  const getMemberActivityToken = useCallback(async (): Promise<string | null> => {
    if (!jwt || !firstFileId) return null
    try {
      const tok = await fetchSyncToken(jwt, id, firstFileId, { projectName: project?.name })
      return tok.token
    } catch {
      return null
    }
  }, [jwt, id, firstFileId, project?.name])




  // ── AQU-1092…1098: the plan board ──────────────────────────────────────
  // `tableNow` is captured once per render pass so every status, group and
  // summary on the page agrees about "now" — a unit must not read Overdue in
  // the summary and Due soon in its row because two clocks disagreed.
  const [selectedPlanUnitId, setSelectedPlanUnitId] = useState<string | null>(null)
  const [planCsvCopied, setPlanCsvCopied] = useState(false)
  const getPlanToken = useMemo(() => {
    if (!id || !jwt) return null
    return async () => {
      const token = await fetchSyncToken(jwt, id, firstFileId ?? id, { projectName: project?.name })
      return token.token
    }
  }, [id, jwt, firstFileId, project?.name])
  const {
    units: planUnits,
    patchUnit: patchPlanUnit,
    status: planStatus,
    refresh: refreshPlan,
  } = useProjectPlan({ projectId: id ?? null, lane: selectedLaneTag ?? "", getToken: getPlanToken })
  /**
   * The rows the board is actually drawing, in drawn order. The board owns the
   * filter, the arrangement and the folds that decide this, so the inspector's
   * prev/next buttons have to read it from there rather than re-deriving it —
   * re-deriving is how they ended up stepping onto rows nobody could see.
   */
  const planOrderRef = useRef<PlanUnit[]>([])
  const tableNow = useMemo(() => Date.now(), [planUnits])
  const planLgUp = useIsLgUp()
  const selectedPlanUnit = useMemo(
    () => planUnits.find((u) => planUnitId(u) === selectedPlanUnitId) ?? null,
    [planUnits, selectedPlanUnitId],
  )
  const planShowAudio = useMemo(() => planHasAudio(planUnits), [planUnits])
  // AQU-1094/1095: setting a date and marking a unit done are maintainer work,
  // the same floor the project deadline uses. Read the FRESH role from
  // useProject, not the cached syncRole snapshot.
  const canPlan = (roleLevel ?? 0) >= 600
  const stepPlanUnit = useCallback(
    (delta: number) => {
      const ordered = planOrderRef.current
      if (ordered.length === 0) return
      const index = ordered.findIndex((u) => planUnitId(u) === selectedPlanUnitId)
      const next = index < 0
        ? ordered[0]
        : ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))]
      if (next) setSelectedPlanUnitId(planUnitId(next))
    },
    [selectedPlanUnitId],
  )
  // The lane whose numbers the inspector is showing, named the way the lane
  // tabs name it — so nobody reads a French percentage as a Spanish one.
  // Labeled exactly as the lane tabs label it: the project's target language
  // for the default lane, the lane tag itself for any other. Derived here
  // rather than read off `selectedLane`, which is declared further down.
  const planLanguageLabel = selectedLaneTag || project?.targetLanguage || null
  const planInspector = selectedPlanUnit ? (
    <PlanInspector
      key={planUnitId(selectedPlanUnit)}
      unit={selectedPlanUnit}
      now={tableNow}
      canPlan={canPlan}
      showAudio={planShowAudio}
      projectId={id ?? null}
      getToken={getPlanToken}
      lane={selectedLaneTag ?? ""}
      languageLabel={planLanguageLabel}
      onPatch={patchPlanUnit}
      onClose={() => setSelectedPlanUnitId(null)}
      onStep={stepPlanUnit}
    />
  ) : null
  // Selecting a unit that a refetch removed (a file deleted elsewhere) would
  // leave the inspector pointing at nothing.
  useEffect(() => {
    if (selectedPlanUnitId && !planUnits.some((u) => planUnitId(u) === selectedPlanUnitId)) {
      setSelectedPlanUnitId(null)
    }
  }, [planUnits, selectedPlanUnitId])

  const planCsv = useCallback(() => planRowsToCsv(planUnits, tableNow), [planUnits, tableNow])
  const handleCopyPlanCsv = useCallback(() => {
    void navigator.clipboard.writeText(planCsv()).then(() => {
      setPlanCsvCopied(true)
      window.setTimeout(() => setPlanCsvCopied(false), 1500)
    })
  }, [planCsv])
  const handleDownloadPlanCsv = useCallback(() => {
    downloadBlob(
      new Blob([planCsv()], { type: "text/csv;charset=utf-8;" }),
      planCsvFilename(project?.name ?? "project"),
    )
  }, [planCsv, project?.name])

  const isOwner = (project?.syncRole?.level ?? 0) >= 700
  const canManage = (project?.syncRole?.level ?? 0) >= 600
  const canAssign = (project?.syncRole?.level ?? 0) >= 500
  const canToggleLifecycle = (project?.syncRole?.level ?? 0) >= 500
  const isArchived = Boolean(project?.deletedAt)

  const { isFrozen, toggle: toggleLifecycle, busy: lifecycleBusy } = useProjectLifecycle(
    id,
    project,
    () => refresh(),
  )

  async function handleToggleLifecycle() {
    if (!jwt) return
    setError(null)
    const result = await toggleLifecycle(jwt)
    if (!result.ok) setError(result.message)
    else await refresh()
  }
  const dstatus = audio ? deadlineStatus(audio, Date.now()) : null
  const projectStatus = deriveProjectStatus(audio, Date.now())

  // Conditionality flags
  const hasText = audio != null && audio.totalCells > 0
  const hasAudio = audio != null && audio.audioCells > 0
  const showText = hasText
  const showAudio = hasAudio

  // AQU-538 §3.3: lane tabs + tile recompute. Tabs only surface once a project
  // has more than one lane (N=1 stays byte-identical). `activeLane` is the
  // PortfolioLane the tabs are filtered to (null = "All"); when set, the
  // Translated/Validated tiles + bars read that lane, and the cross-language
  // tiles (AI Drafted, audio) grey out — they have no per-lane breakdown.
  const projectLanes: PortfolioLane[] = audio?.lanes ?? []
  const showLaneTabs = projectLanes.length > 1
  const laneTabOptions = [
    { label: t("org.orgHome.statusFilter.all"), value: LANE_TAB_ALL },
    ...projectLanes.map((l) => ({
      label: l.lane === "" ? (project?.targetLanguage || t("org.projectOverview.laneDefaultFallback")) : l.lane,
      value: l.lane === "" ? LANE_TAB_DEFAULT : l.lane,
    })),
  ]
  const activeLane: PortfolioLane | null =
    selectedLaneTag != null ? projectLanes.find((l) => l.lane === selectedLaneTag) ?? null : null
  const tileTranslatedPct = activeLane ? laneTranslatedPct(activeLane) : audio ? translatedPct(audio) : 0
  const tileValidatedPct = activeLane ? laneValidatedPct(activeLane) : audio ? validatedPct(audio) : 0
  const CROSS_LANE_TOOLTIP = t("org.projectOverview.crossLaneTooltip")

  // AQU-593: which stat widgets are applicable to this project (drives the
  // Customize menu). Audio tiles only apply to audio projects; the AI-Drafted
  // tile only applies once some cells were AI-drafted. A hidden key is honored
  // at render time via `statVisible`.
  const availableStatKeys: StatKey[] = [
    ...(showText ? (["translated"] as StatKey[]) : []),
    ...(showText && (audio?.aiDraftedCells ?? 0) > 0 ? (["ai-drafted"] as StatKey[]) : []),
    ...(showText ? (["validated"] as StatKey[]) : []),
    ...(showAudio ? (["has-audio", "audio-validated"] as StatKey[]) : []),
  ]
  const statVisible = (key: StatKey) => !hiddenStats.has(key)

  async function saveDeadline(value: string | null) {
    if (!jwt) return
    setBusy(true)
    setError(null)
    try {
      await setProjectDeadline(jwt, id, value)
      await loadRow()
      setDeadlineDialogOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function savePm(pmUserId: number | null) {
    if (!jwt) return
    setBusy(true)
    setError(null)
    try {
      await setProjectPm(jwt, id, pmUserId)
      await refresh()
      // AQU-507: the org overview's PM column joins from the app-wide
      // accessible-projects directory (OrgContext, fetched once per session) —
      // revalidate it so the new PM shows there without a hard reload. Not
      // awaited: the header PM field reads useProject, not the directory.
      void refreshAccessibleProjects()
      setPmDialogOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDownloadBundle() {
    if (!jwt || !project) return
    const fileId = project.files[0]?.id
    if (!fileId) {
      setError(t("org.projectOverview.noFilesToExport"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await downloadProjectBundle({ projectId: id, projectName: project.name, jwt, fileId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleArchive() {
    if (!jwt) return
    setBusy(true)
    setError(null)
    const res = await archiveProjectRemote(id, jwt)
    setBusy(false)
    if (res.kind === "archived" || res.kind === "local-only") {
      // Member orgs split Overview (`/orgs/:id`) from Projects — land on the
      // projects table so the archived row is gone from the active list.
      navigate(activeOrgId != null ? orgProjectsPath(activeOrgId) : "/projects")
    } else if (res.kind === "forbidden") {
      setError(res.message ?? t("org.projectOverview.archiveForbidden"))
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  async function handleRestore() {
    if (!jwt) return
    setBusy(true)
    setError(null)
    const res = await unarchiveProjectRemote(id, jwt)
    setBusy(false)
    if (res.kind === "restored" || res.kind === "local-only") {
      await refresh()
    } else if (res.kind === "forbidden") {
      setError(res.message ?? t("org.projectOverview.restoreForbidden"))
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  // Language pair label, e.g. "Greek → Bambara". Arrow is wrapped so it
  // visually mirrors under RTL instead of pointing away from the target.
  const languagePair =
    project?.sourceLanguage && project?.targetLanguage ? (
      <>
        {project.sourceLanguage} <span className="inline-block rtl:-scale-x-100">→</span> {project.targetLanguage}
      </>
    ) : (
      project?.targetLanguage ?? project?.sourceLanguage ?? null
    )

  if (status === "no-session") {
    return (
      <SignedOutWorkspace
        header={<OrgBreadcrumb section={project?.name ?? t("common.project")} orgId={project?.orgId} />}
      />
    )
  }

  const nonReadyContent =
    status === "loading" ? (
      <LoadingTemplate
        label={t("org.projectOverview.loadingProjectDetails")}
        className="min-h-[34rem] max-w-5xl"
        data-testid="project-overview-loading"
      >
        <ProjectOverviewSkeleton />
      </LoadingTemplate>
    ) : status === "unreachable" ? (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
        <span className="text-amber-800 dark:text-amber-200">
          {t("org.projectOverview.unreachableMessage")}
        </span>
        <Button
          type="button"
          onClick={refresh}
          className="shrink-0 bg-amber-800 text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
        >
          {t("common.retry")}
        </Button>
      </div>
    ) : null

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={project?.name ?? t("common.project")} orgId={project?.orgId} />}
      statusBar={null}
      // AQU-1094…1098: wide enough, the inspector takes REAL width and the
      // board reflows beside it — no dim, no covering, so you can keep
      // clicking rows and watch one move to Done as you mark it. Narrower, it
      // becomes an overlay, which is the same trade AppShell makes for the
      // navigation rail at this breakpoint.
      aside={
        planInspector && planLgUp ? (
          <RightSidebarPanel
            storageKey="plan-inspector"
            defaultWidth={384}
            minWidth={300}
            maxWidth={560}
            resizeLabel={t("org.projectOverview.plan.resizeInspector")}
          >
            {planInspector}
          </RightSidebarPanel>
        ) : null
      }
      main={
        <div className="h-full overflow-y-auto">
          {openingOverlay}
          {isFrozen && status === "ready" && project && (
            <InactiveProjectBanner
              projectName={project.name}
              canReactivate={canToggleLifecycle}
              onReactivate={handleToggleLifecycle}
              busy={lifecycleBusy}
            />
          )}
          <div className="p-6">
            {status !== "ready" ? (
              nonReadyContent
            ) : (
              <div className="max-w-5xl space-y-4">
              {/* ── Header card ── */}
              <div className="rounded-lg border bg-card p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-xl font-semibold leading-tight truncate">{project?.name}</h1>
                      {/* Compact status chip next to the title */}
                      <StatusChip status={projectStatus} />
                      {isArchived && <ProjectStatusChip kind="archived" className="shrink-0" />}
                      {!isArchived && isFrozen && (
                        <Badge
                          className="shrink-0 border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          data-testid="overview-inactive-badge"
                        >
                          {t("org.projectOverview.inactiveBadge")}
                        </Badge>
                      )}
                    </div>
                    {/* Language pair */}
                    {languagePair && (
                      <p className="mt-0.5 text-sm text-muted-foreground">{languagePair}</p>
                    )}
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {t("search.expanded.fileCount", { count: project?.files.length ?? 0 })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      onClick={() => openWorkspace(`/project/${id}/editor`)}
                      disabled={openPending}
                      aria-busy={openPending || undefined}
                    >
                      {openPending ? (
                        <>
                          <Spinner className="size-4" />
                          {t("auth.accessLink.submitOpening")}
                        </>
                      ) : (
                        t("auth.accessLink.submitDefault")
                      )}
                    </Button>
                    {id && (
                      <Link
                        to={projectSettingsPath(id)}
                        state={{ backgroundLocation: location, projectSettingsModalDepth: 1 }}
                        aria-label={t("editor.navTitle.projectSettings")}
                        data-testid="overview-project-settings"
                        className={cn(buttonVariants({ variant: "outline", size: "icon-sm" }), "shrink-0")}
                      >
                        <Settings className="h-4 w-4" />
                      </Link>
                    )}
                    {isOwner && isArchived && (
                      <Button size="sm" variant="outline" onClick={handleRestore} disabled={busy}>
                        {t("common.restore")}
                      </Button>
                    )}
                    {/* Archive + Download + Lifecycle moved into overflow menu */}
                    {(canManage || isOwner || canToggleLifecycle) && !isArchived && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="outline"
                              aria-label={t("org.projectOverview.moreActionsAria")}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="min-w-40">
                          {canManage && (
                            <DropdownMenuItem
                              onClick={handleDownloadBundle}
                              disabled={busy || (project?.files.length ?? 0) === 0}
                            >
                              <Download className="size-4" />
                              {t("org.projectOverview.downloadDeliverable")}
                            </DropdownMenuItem>
                          )}
                          {canToggleLifecycle && (
                            <DropdownMenuItem
                              onClick={handleToggleLifecycle}
                              disabled={lifecycleBusy}
                            >
                              {isFrozen ? (
                                <PlayCircle className="size-4" />
                              ) : (
                                <PauseCircle className="size-4" />
                              )}
                              {isFrozen ? t("org.projectOverview.markAsActive") : t("org.projectOverview.markAsInactive")}
                            </DropdownMenuItem>
                          )}
                          {isOwner && (
                            <DropdownMenuItem
                              onClick={() => setArchiveConfirmOpen(true)}
                              disabled={busy}
                              variant="destructive"
                            >
                              <Archive className="size-4" />
                              {t("org.projectOverview.archive")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-start gap-4" data-testid="overview-project-meta">
                  <Field className="w-auto min-w-48">
                    <FieldLabel className="text-xs font-semibold text-muted-foreground">
                      {t("org.projectOverview.projectManagerHeading")}
                    </FieldLabel>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {pm ? (
                        <UsernameWithAvatar username={pm.username} nameTestId="overview-pm-name" />
                      ) : (
                        <span className="text-muted-foreground" data-testid="overview-pm-name">
                          {t("org.projectOverview.unassigned")}
                        </span>
                      )}
                      {canManage && (
                        <MetaFieldEditButton
                          label={
                            pm
                              ? t("org.projectOverview.changeProjectManagerDialogTitle")
                              : t("org.projectOverview.assignProjectManagerDialogTitle")
                          }
                          disabled={busy}
                          testId="overview-pm-edit"
                          onClick={() => {
                            setPmSelection(pm ? String(pm.id) : "")
                            setPmDialogOpen(true)
                          }}
                        />
                      )}
                    </div>
                  </Field>
                  <Field className="w-auto min-w-56">
                    <FieldLabel className="text-xs font-semibold text-muted-foreground">
                      {t("org.projectOverview.deadlineHeading")}
                    </FieldLabel>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {audio?.deadlineAt ? (
                        <span className="flex items-center gap-2 font-medium">
                          <DateTooltip
                            value={audio.deadlineAt}
                            label={t("org.assignedToMe.dueColumnLabel")}
                            variant="deadline"
                          />
                          <DeadlineChip status={dstatus} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("org.projectOverview.noDeadlineSet")}</span>
                      )}
                      {canManage && (
                        <MetaFieldEditButton
                          label={
                            audio?.deadlineAt
                              ? t("org.projectOverview.changeDeadlineDialogTitle")
                              : t("org.projectOverview.setDeadlineDialogTitle")
                          }
                          disabled={busy}
                          testId="overview-deadline-edit"
                          onClick={() => {
                            setDeadlineDate(deadlineStringToDate(audio?.deadlineAt))
                            setDeadlineDialogOpen(true)
                          }}
                        />
                      )}
                    </div>
                  </Field>
                </div>

                <Dialog open={deadlineDialogOpen} onOpenChange={setDeadlineDialogOpen}>
                  <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                      <DialogTitle>
                        {audio?.deadlineAt ? t("org.projectOverview.changeDeadlineDialogTitle") : t("org.projectOverview.setDeadlineDialogTitle")}
                      </DialogTitle>
                      <DialogDescription>
                        {t("org.projectOverview.deadlineDialogDescription")}
                      </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="project-deadline">{t("org.projectOverview.deadlineDateLabel")}</FieldLabel>
                        <DatePicker
                          id="project-deadline"
                          value={deadlineDate}
                          onChange={setDeadlineDate}
                          disabled={busy}
                          placeholder={t("org.projectOverview.deadlineDatePlaceholder")}
                        />
                      </Field>
                    </FieldGroup>
                    <DialogFooter>
                      {audio?.deadlineAt && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          className="sm:me-auto"
                          onClick={() => saveDeadline(null)}
                        >
                          {t("common.clear")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setDeadlineDialogOpen(false)}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        disabled={busy || !deadlineDate}
                        onClick={() => saveDeadline(deadlineDate ? dateToDeadlineString(deadlineDate) : null)}
                      >
                        {t("common.save")}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Dialog open={pmDialogOpen} onOpenChange={setPmDialogOpen}>
                  <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                      <DialogTitle>{pm ? t("org.projectOverview.changeProjectManagerDialogTitle") : t("org.projectOverview.assignProjectManagerDialogTitle")}</DialogTitle>
                      <DialogDescription>
                        {t("org.projectOverview.pmDialogDescription")}
                      </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="project-pm">{t("org.projectOverview.projectManagerHeading")}</FieldLabel>
                        <Select
                          value={pmSelection}
                          onValueChange={(v) => setPmSelection(v ?? "")}
                          items={[
                            { value: "", label: t("org.projectOverview.unassigned") },
                            ...pmCandidates.map((m) => ({
                              value: String(m.userId),
                              label: m.username,
                            })),
                          ]}
                        >
                          <SelectTrigger id="project-pm" aria-label={t("org.projectOverview.projectManagerHeading")}>
                            <SelectValue placeholder={t("org.projectOverview.selectMemberPlaceholder")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="">{t("org.projectOverview.unassigned")}</SelectItem>
                              {pmCandidates.map((m) => (
                                <SelectItem key={m.userId} value={String(m.userId)}>
                                  <UsernameWithAvatar
                                    username={m.username}
                                    size="xs"
                                    menuSafe
                                    nameClassName="text-sm font-normal"
                                  />
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </FieldGroup>
                    <DialogFooter>
                      {pm && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          className="sm:me-auto"
                          onClick={() => savePm(null)}
                        >
                          {t("common.clear")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setPmDialogOpen(false)}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => savePm(pmSelection === "" ? null : Number(pmSelection))}
                      >
                        {t("common.save")}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <ConfirmActionDialog
                  open={archiveConfirmOpen}
                  onOpenChange={setArchiveConfirmOpen}
                  title={t("org.projectOverview.archiveDialogTitle")}
                  description={
                    project?.name
                      ? `Archive "${project.name}"? It will be hidden from the active projects list. Data is kept and owners can restore it anytime from Archived projects.`
                      : "Archive this project? It will be hidden from the active projects list. Data is kept and owners can restore it anytime from Archived projects."
                  }
                  confirmLabel="Archive"
                  checkboxLabel="I understand this project will be hidden from the active list."
                  variant="destructive"
                  onConfirm={() => {
                    void handleArchive()
                  }}
                />

                {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
              </div>

              {/* ── Progress card ── */}
              {/* AQU-486: progress has no configurable floor today — everyone
                  with project access can see it. The badge is read-only
                  (informational), matching that reality rather than implying
                  a toggle that doesn't exist server-side. */}
              {audio && audio.totalCells > 0 && (
                <div className="rounded-lg border bg-card p-5" data-testid="progress-card">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold text-muted-foreground">{t("fileDetails.progress")}</h2>
                    <div className="flex items-center gap-1.5">
                      {/* AQU-593: hide stat widgets you don't find helpful. */}
                      {availableStatKeys.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            data-testid="customize-stats-trigger"
                            aria-label={t("org.projectOverview.customizeStatsAria")}
                            render={
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent/40 hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
                              />
                            }
                          >
                            <SlidersHorizontal className="size-3.5" aria-hidden />
                            {t("common.customize")}
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>{t("org.projectOverview.showStats")}</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {STAT_WIDGETS.filter((w) => availableStatKeys.includes(w.key)).map((w) => (
                                <DropdownMenuCheckboxItem
                                  key={w.key}
                                  checked={statVisible(w.key)}
                                  closeOnClick={false}
                                  onCheckedChange={() => toggleStat(w.key)}
                                  data-testid={`customize-stat-${w.key}`}
                                >
                                  {t(w.labelKey)}
                                </DropdownMenuCheckboxItem>
                              ))}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <SectionVisibilityBadge minRole={ROLE.VIEWER} />
                    </div>
                  </div>

                  {/* AQU-538 §3.3: lane filter tabs — All + one per lane
                      (default lane labeled with the project's targetLanguage).
                      Only rendered when the project has >1 lane. */}
                  {showLaneTabs && (
                    <div className="mb-3" data-testid="lane-filter-tabs">
                      <SegmentTabs
                        value={laneTagToTab(selectedLaneTag)}
                        onValueChange={(next) => setSelectedLaneTag(tabToLaneTag(next))}
                        aria-label={t("org.projectOverview.filterProgressByLanguageAriaLabel")}
                        options={laneTabOptions}
                      />
                    </div>
                  )}

                  {/* Big-number tiles lead the section */}
                  <div className="flex flex-wrap gap-3 mb-4">
                    {showText && (
                      <>
                        {statVisible("translated") && (
                          <StatTile label={t("org.orgHome.table.translatedHeaderLabel")} pct={tileTranslatedPct} colorClass="text-amber-600" />
                        )}
                        {audio.aiDraftedCells > 0 && statVisible("ai-drafted") && (
                          <StatTile
                            label={t("org.projectOverview.aiDrafted")}
                            pct={aiDraftedPct(audio)}
                            colorClass={activeLane ? "text-muted-foreground/60" : "text-violet-600"}
                            tooltip={activeLane ? CROSS_LANE_TOOLTIP : t("org.projectOverview.aiDraftedTooltip")}
                          />
                        )}
                        {statVisible("validated") && (
                          <StatTile label={t("org.orgHome.table.validatedHeaderLabel")} pct={tileValidatedPct} colorClass="text-emerald-600" />
                        )}
                      </>
                    )}
                    {showAudio && (
                      <>
                        {statVisible("has-audio") && (
                          <StatTile
                            label={t("org.orgHome.table.audioHeaderLabel")}
                            pct={audioPct(audio)}
                            colorClass={activeLane ? "text-muted-foreground/60" : "text-sky-600"}
                            tooltip={activeLane ? CROSS_LANE_TOOLTIP : t("org.projectOverview.hasAudioTooltip")}
                          />
                        )}
                        {/*
                         * AQU-1092: the metric the old placeholder said was missing now
                         * exists. `cell_audio.approved` landed with AQU-508 and the org
                         * portfolio counts it (auth-worker org-permissions: audio cells
                         * whose SELECTED take is approved), so this reads a real number.
                         *
                         * AQU-1093: denominator is `totalCells`, like every other tile
                         * here AND like the plan board below, whose audio bar divides by
                         * every cell in the unit. It used to divide by `audioCells`, so
                         * one project reported two different audio-validated percentages
                         * on one page. The share of RECORDED audio that is validated is
                         * the more natural reviewer's question, so it survives in the
                         * tooltip rather than being dropped.
                         *
                         * Greyed with the cross-lane tooltip like "Has Audio": takes hang
                         * off the cell, not a language lane, so there is nothing per-lane
                         * to show.
                         */}
                        {statVisible("audio-validated") && (
                          <StatTile
                            label={t("org.projectOverview.audioValidated")}
                            pct={audioValidatedPct(audio)}
                            colorClass={activeLane ? "text-muted-foreground/60" : "text-sky-700"}
                            tooltip={activeLane ? CROSS_LANE_TOOLTIP : [
                              t("org.projectOverview.audioValidatedTooltip"),
                              t("org.projectOverview.audioValidatedOfRecorded", {
                                percent: Math.round(audioValidatedOfRecordedPct(audio) * 100),
                              }),
                            ].join(" ")}
                          />
                        )}
                      </>
                    )}
                  </div>

                  {/* Detail bars below tiles. AQU-538: Translated/Validated
                      follow the active lane; the cross-language AI/audio bars
                      only render in the "All" view (no per-lane breakdown). */}
                  <div className="space-y-2.5">
                    {showText && (
                      <>
                        {statVisible("translated") && (
                          <StatBar
                            label={t("org.orgHome.table.translatedHeaderLabel")}
                            value={activeLane ? activeLane.filledCells : audio.filledCells}
                            total={activeLane ? activeLane.totalCells : audio.totalCells}
                            fillClass="bg-amber-500"
                            suffix={t("org.projectOverview.cellsSuffix")}
                          />
                        )}
                        {!activeLane && audio.aiDraftedCells > 0 && statVisible("ai-drafted") && (
                          <StatBar
                            label={t("org.projectOverview.aiDrafted")}
                            value={audio.aiDraftedCells}
                            total={audio.totalCells}
                            fillClass="bg-violet-500"
                            suffix={t("org.projectOverview.cellsSuffix")}
                          />
                        )}
                        {statVisible("validated") && (
                          <StatBar
                            label={t("org.orgHome.table.validatedHeaderLabel")}
                            value={activeLane ? activeLane.validatedCells : audio.validatedCells}
                            total={activeLane ? activeLane.totalCells : audio.totalCells}
                            fillClass="bg-emerald-500"
                            suffix={t("org.projectOverview.cellsSuffix")}
                          />
                        )}
                      </>
                    )}
                    {showAudio && !activeLane && statVisible("has-audio") && (
                      <>
                        <StatBar
                          label={t("org.orgHome.table.audioHeaderLabel")}
                          value={audio.audioCells}
                          total={audio.totalCells}
                          fillClass="bg-sky-500"
                          suffix={t("org.projectOverview.cellsSuffix")}
                        />
                        {/* TODO: confirm whether legacy GitLab project import populated audio (cell_audio) — see AQU-160 data gap */}
                      </>
                    )}
                  </div>
                  {!activeLane && audio.recordedMs > 0 && statVisible("has-audio") && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t("org.projectOverview.audioRecordedSummary", {
                        minutes: recordedMinutes(audio),
                        percent: bidiIsolate(`${Math.round(audioPct(audio) * 100)}%`),
                      })}
                    </p>
                  )}
                </div>
              )}

              {/* ── Languages / lane table (AQU-538 §3.3) ── */}
              {/* Rendered only when the project has more than one target
                  language lane — N=1 projects are byte-identical to before. */}
              {showLaneTabs && audio && (
                <OverviewLaneTable
                  projectId={id}
                  orgId={portfolioOrgId}
                  jwt={jwt}
                  lanes={projectLanes}
                  defaultLanguageLabel={project?.targetLanguage || t("org.projectOverview.laneDefaultFallback")}
                  extraLanes={project?.targetLanes ?? []}
                  files={project?.files ?? []}
                  roleLevel={project?.syncRole?.level ?? 0}
                  author={session?.username ?? ""}
                  canManageLanes={canAssign}
                  canAddLanguage={canManage}
                  onChanged={handleAssigned}
                />
              )}

              {/* ── Autopilot (PM observability) ──
                  Every other autopilot surface is scoped to one open file and
                  dies with the editor. A PM does not open files; this is the
                  only place that answers "what is drafting, and how much is
                  waiting on my team". Renders nothing when the backend isn't
                  deployed for this environment. */}
              {project && isAutopilotVisible(project) && (
                <ProjectAutopilotPanel
                  key={id}
                  projectId={id}
                  fileNames={autopilotFileNames}
                  canStart={(roleLevel ?? 0) >= ROLE.CONTRIBUTOR}
                />
              )}

              {/* ── Per-file rows (always fully visible per user decision) ── */}
              {/* AQU-1092…1098: the plan replaces the old file breakdown.
                  That card listed files with progress bars and a nested
                  book/chapter/verse drill-down; it answered "how far along is
                  this file", never "are we finishing on time". The plan groups
                  planning units by status, and the per-unit detail moved into
                  the inspector beside it. */}
              {planInspector && !planLgUp && (
                <Sheet open onOpenChange={(open) => { if (!open) setSelectedPlanUnitId(null) }}>
                  <SheetContent side="right" className="w-full p-0 sm:max-w-md!">
                    <SheetHeader className="sr-only">
                      <SheetTitle>
                        {t("org.projectOverview.plan.inspectorAria", {
                          unit: selectedPlanUnit ? planUnitLabel(selectedPlanUnit) : "",
                        })}
                      </SheetTitle>
                    </SheetHeader>
                    {planInspector}
                  </SheetContent>
                </Sheet>
              )}
              <PlanBoard
                units={planUnits}
                now={tableNow}
                projectId={id ?? null}
                status={planStatus}
                onRetry={refreshPlan}
                orderRef={planOrderRef}
                selectedId={selectedPlanUnitId}
                onSelect={setSelectedPlanUnitId}
                emptyAction={
                  <Button
                    size="sm"
                    data-testid="plan-empty-import"
                    disabled={openPending}
                    onClick={() => openWorkspace(`/project/${id}/editor`)}
                  >
                    {t("org.projectOverview.plan.importSource")}
                  </Button>
                }
                actions={
                  orgSettings.canExport && planUnits.length > 0 ? (
                    <ButtonGroup>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="plan-csv-copy"
                        onClick={handleCopyPlanCsv}
                      >
                        {planCsvCopied
                          ? t("common.copied")
                          : t("org.projectOverview.copyCsv")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="plan-csv-download"
                        onClick={handleDownloadPlanCsv}
                      >
                        {t("org.projectOverview.downloadCsv")}
                      </Button>
                    </ButtonGroup>
                  ) : null
                }
              />

              {/* AQU-656: original imported blobs. Hidden when the org export
                  floor forbids it, and when no file has a stored original —
                  Codex-migrated / pre-sidecar files are AQU-991, not a
                  storage-audit empty state here. */}
              {orgSettings.canExport && originalFiles.length > 0 && jwt && (
                <div className="rounded-lg border bg-card p-5" data-testid="imported-originals">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold text-muted-foreground">
                      {t("org.projectOverview.importedOriginalsHeading")}
                    </h2>
                    <AppTooltip content={t("org.projectOverview.downloadOriginalsTooltip")}>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="download-originals-zip"
                        onClick={() => {
                          const fileId = project?.files[0]?.id ?? originalFiles[0]?.fileId
                          if (!fileId) return
                          void downloadImportedOriginalsZip({
                            projectId: id,
                            projectName: project?.name ?? "project",
                            jwt,
                            fileId,
                          })
                        }}
                      >
                        {t("org.projectOverview.downloadOriginals")}
                      </Button>
                    </AppTooltip>
                  </div>
                  <ul
                    id="imported-originals-list"
                    className="space-y-1"
                    aria-label={t("org.projectOverview.importedOriginalsListAria")}
                  >
                    {visibleOriginals.map((f) => (
                      <li key={f.fileId} className="flex items-center gap-3 text-sm">
                        <span className="min-w-0 flex-1 font-medium">
                          <ExpandableName name={f.name} />
                        </span>
                        <AppTooltip content={t("fileDetails.downloadOriginal")}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            aria-label={t("org.projectOverview.downloadOriginalAria", { fileName: f.name })}
                            data-testid="download-original-file"
                            onClick={() => {
                              void downloadImportedOriginal({
                                projectId: id,
                                file: { id: f.fileId, name: f.name, type: f.fileType },
                                getToken: async (fileId) => {
                                  const tok = await fetchSyncToken(jwt, id, fileId, {
                                    projectName: project?.name,
                                  })
                                  return tok.token
                                },
                              })
                            }}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </AppTooltip>
                      </li>
                    ))}
                  </ul>
                  {originalFiles.length > ORIGINALS_PAGE_SIZE && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      {/* "Show more" only earns its place while a full batch is
                          still hidden — once fewer than a page remains it would
                          do exactly what "Show all" does. */}
                      {hiddenOriginalsCount > ORIGINALS_PAGE_SIZE && (
                        <button
                          type="button"
                          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                          aria-controls="imported-originals-list"
                          data-testid="imported-originals-show-more"
                          onClick={() => setOriginalsShown((n) => n + ORIGINALS_PAGE_SIZE)}
                        >
                          {t("org.projectOverview.importedOriginalsShowMore", {
                            count: ORIGINALS_PAGE_SIZE,
                          })}
                        </button>
                      )}
                      {hiddenOriginalsCount > 0 ? (
                        <button
                          type="button"
                          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                          aria-controls="imported-originals-list"
                          aria-expanded={false}
                          data-testid="imported-originals-show-all"
                          onClick={() => setOriginalsShown(originalFiles.length)}
                        >
                          {t("org.projectOverview.importedOriginalsShowAll", {
                            count: originalFiles.length,
                          })}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                          aria-controls="imported-originals-list"
                          aria-expanded={true}
                          data-testid="imported-originals-show-fewer"
                          onClick={() => setOriginalsShown(ORIGINALS_PAGE_SIZE)}
                        >
                          {t("org.projectOverview.showFewer")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Team / Assignments card ── */}
              {/* AQU-486: per-assignee progress is gated by the AQU-485
                  memberProgressViewMinRole floor (same "who sees each
                  person's productivity" policy WorkloadRollup/UsageRollup use
                  on the org overview) — a lower-role account must not see
                  this card exist at all, not an empty/placeholder version. */}
              <SectionVisibilityGate
                minRole={orgSettings.memberProgressViewMinRole}
                viewerRoleLevel={projectRoleLevel}
                ready={orgSettings.hasFetched}
              >
                <div className={cn("relative rounded-lg border bg-card p-5", sectionTintClass(orgSettings.memberProgressViewMinRole))}>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold text-muted-foreground">{t("editor.navTitle.team")}</h2>
                    <SectionVisibilityBadge
                      minRole={orgSettings.memberProgressViewMinRole}
                      canEdit={canEditVisibility}
                      onChangeMinRole={async (next) => { await orgSettings.patch({ memberProgressViewMinRole: next }) }}
                      description={t("org.projectOverview.teamVisibilityDescription")}
                    />
                  </div>
                  {workload.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("org.projectOverview.noOpenAssignments")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {workload.map((w) => {
                        const donePct = w.cellsTotal > 0 ? Math.round((w.cellsDone / w.cellsTotal) * 100) : 0
                        const isSelected = w.username != null && w.username === selectedMemberUsername
                        return (
                          <li key={w.userId} className="flex items-center gap-3 text-sm">
                            {/* AQU-491: click-to-reveal affordance, see file-name cell above. */}
                            <AppTooltip content={w.username ?? String(w.userId)}>
                              <span className="flex w-40 shrink-0 items-center gap-2 font-medium">
                                <InitialsAvatar
                                  name={w.username ?? t("org.workloadRollup.unknownUser", { id: w.userId })}
                                  size="sm"
                                  className="shrink-0"
                                />
                                <ExpandableName name={w.username ?? t("org.workloadRollup.unknownUser", { id: w.userId })} />
                              </span>
                            </AppTooltip>
                            <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${donePct}%` }} />
                            </span>
                            <span className="w-20 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                              {t("org.projectOverview.openAssignmentsStat", {
                                count: w.openAssignments,
                                percent: bidiIsolate(`${donePct}%`),
                              })}
                            </span>
                            {/* AQU-498: select a teammate to see their recent actions +
                                files-worked-on rollup. Sits inside this SAME
                                memberProgressViewMinRole gate, so no separate
                                permission plumbing is needed here. */}
                            {w.username != null && (
                              <Button
                                type="button"
                                variant="ghost"
                                className="h-6 shrink-0 px-2 text-xs text-muted-foreground"
                                aria-label={t("org.projectOverview.viewActivityAria", { username: w.username })}
                                aria-pressed={isSelected}
                                onClick={() => setSelectedMemberUsername(isSelected ? null : (w.username as string))}
                              >
                                {isSelected ? t("org.projectOverview.hide") : t("autopilot.inspector.activity.title")}
                              </Button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  {selectedMemberUsername && (
                    <MemberActivityPanel
                      projectId={id}
                      username={selectedMemberUsername}
                      getToken={getMemberActivityToken}
                      onClose={() => setSelectedMemberUsername(null)}
                    />
                  )}

                  {canAssign && !isArchived && activeOrgId != null && (project?.files.length ?? 0) > 0 && (
                    <div className="mt-3 pt-3 border-t">
                      <AssignWork
                        projectId={id}
                        files={project?.files ?? []}
                        jwt={jwt ?? ""}
                        author={session?.username ?? ""}
                        onAssigned={handleAssigned}
                      />
                    </div>
                  )}
                </div>
              </SectionVisibilityGate>
            </div>
          )}
          </div>
        </div>
      }
    />
  )
}
