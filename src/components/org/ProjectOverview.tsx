import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { MoreHorizontal, ChevronRight, Copy, Check, Download, Search, SlidersHorizontal, Archive, PlayCircle, PauseCircle, Settings } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { AppTooltip } from "@/components/ui/tooltip"
import { ExpandableName } from "@/components/ui/expandable-name"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { Button, buttonVariants } from "@/components/ui/button"
import { orgProjectsPath, projectSettingsPath } from "@/lib/navigation/org-paths"
import { Spinner } from "@/components/ui/spinner"
import { ButtonGroup } from "@/components/ui/button-group"
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
import { AssignWork } from "./AssignWork"
import { MembersTab } from "@/components/ProjectMembersPage"
import { MemberActivityPanel } from "./MemberActivityPanel"
import { ProjectAutopilotPanel } from "./ProjectAutopilotPanel"
import { getPortfolio, translatedPct, validatedPct, aiDraftedPct, audioPct, recordedMinutes, deadlineStatus, laneTranslatedPct, laneValidatedPct, type PortfolioProject, type PortfolioLane } from "@/lib/frontier/portfolio"
import { OverviewLaneTable } from "./OverviewLaneTable"
import { fetchProjectFiles, type FileSummary } from "@/lib/sync/cells-read"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import {
  progressToCanonicalRollup,
  sectionProgressToVerseRollup,
  type BookRollup,
  type ChapterRollup,
  type VerseRollup,
} from "@/lib/progress/canonical-rollup"
import { getFileProgress, getFileSectionProgress } from "@/lib/progress/file-progress-resource"
import { sortFiles, filterFilesByName, FILE_SORT_MODES, type FileSortMode } from "@/lib/progress/file-sort"
import { progressRowsToCsv, progressCsvFilename } from "@/lib/progress/progress-csv"
import { downloadBlob } from "@/lib/export/export-service"
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
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

/** Max per-file rows shown on the overview; the rest are counted as "+N more". */
const FILE_ROW_CAP = 12

type FileProgressSnapshot = Awaited<ReturnType<typeof getFileProgress>>
type ProgressSection = FileProgressSnapshot["sections"][number]

interface FlatSectionRollup {
  key: string
  totalCount: number
  filledCount: number
  approvedCount: number
  filledPct: number
  approvedPct: number
}

interface FileRollup {
  books: BookRollup[] | null
  sections: FlatSectionRollup[]
}

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
  // Overdue / due-soon live only on the Deadline card — avoid duplicating them in the header.
  if (status === "no-deadline" || status === "overdue" || status === "due-soon") return null
  return <ProjectStatusChip kind="on-track" testId="status-chip" />
}

// ── Deadline chip ─────────────────────────────────────────────────────────────

function DeadlineChip({ status }: { status: "overdue" | "soon" | "ok" | null }) {
  if (status === "ok") return <ProjectStatusChip kind="on-track" />
  return <ProjectDeadlineStatuses deadline={status} testId="status-chip" />
}

// ── Stat tiles (big %) ────────────────────────────────────────────────────────

function StatTile({ label, pct, colorClass, tooltip, display }: {
  label: string
  pct: number
  colorClass: string
  tooltip?: string
  /** AQU-490: override the rendered value (e.g. "N/A") when there is no real
   *  metric to show a percentage for. `pct` is still required by callers but
   *  ignored visually when `display` is set. */
  display?: string
}) {
  const tile = (
    <div className="flex flex-col items-center rounded-lg bg-muted/40 px-5 py-3 text-center">
      <p className={`text-2xl font-bold tabular-nums ${colorClass}`}>{display ?? `${Math.round(pct * 100)}%`}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
  return tooltip ? <AppTooltip content={tooltip}>{tile}</AppTooltip> : tile
}

// ── Lane filter pill (AQU-538 §3.3) ───────────────────────────────────────────

function LanePill({ active, onClick, testId, children }: {
  active: boolean
  onClick: () => void
  testId: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
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
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </div>
      <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
        {value}/{total}{suffix ?? ""}
      </span>
    </div>
  )
}

// ── Per-file mini-bars ────────────────────────────────────────────────────────

function FileProgressBars({ tPct, vPct }: { tPct: number; vPct: number }) {
  return (
    <span className="flex flex-1 flex-col gap-[3px]">
      <span className="block h-1.5 rounded-full bg-muted overflow-hidden">
        <span className="block h-full rounded-full bg-amber-500 transition-all" style={{ width: `${tPct}%` }} />
      </span>
      <span className="block h-1.5 rounded-full bg-muted overflow-hidden">
        <span className="block h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${vPct}%` }} />
      </span>
    </span>
  )
}

// ── Chapter/verse rollup (AQU-493) ───────────────────────────────────────────

/** Small inline "N%" bar reused for the book/chapter rows of the rollup tree. */
function MiniRollupBar({ filledPct, approvedPct }: { filledPct: number; approvedPct: number }) {
  return (
    <span className="flex w-24 shrink-0 flex-col gap-[3px]">
      <span className="block h-1 rounded-full bg-muted overflow-hidden">
        <span className="block h-full rounded-full bg-amber-500" style={{ width: `${filledPct}%` }} />
      </span>
      <span className="block h-1 rounded-full bg-muted overflow-hidden">
        <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${approvedPct}%` }} />
      </span>
    </span>
  )
}

function toFlatSectionRollup(section: ProgressSection): FlatSectionRollup {
  const filledPct = section.totalCount > 0
    ? Math.round((section.filledCount / section.totalCount) * 100)
    : 0
  const approvedPct = section.totalCount > 0
    ? Math.round((section.validatedCount / section.totalCount) * 100)
    : 0
  return {
    key: section.key,
    totalCount: section.totalCount,
    filledCount: section.filledCount,
    approvedCount: section.validatedCount,
    filledPct,
    approvedPct,
  }
}

function progressToFileRollup(progress: FileProgressSnapshot): FileRollup {
  return {
    books: progressToCanonicalRollup(progress),
    sections: progress.sections.map(toFlatSectionRollup),
  }
}

function FlatSectionRow({ section }: { section: FlatSectionRollup }) {
  return (
    <li
      data-testid="section-row"
      className="flex w-full items-center gap-2 py-0.5 text-xs"
    >
      <span className="w-10 shrink-0 font-medium">{section.key}</span>
      <MiniRollupBar filledPct={section.filledPct} approvedPct={section.approvedPct} />
      <span className="text-[10px] tabular-nums text-muted-foreground">
        {section.filledCount}/{section.approvedCount}/{section.totalCount}
      </span>
    </li>
  )
}

function ChapterRow({
  chapter,
  loadVerses,
}: {
  chapter: ChapterRollup
  loadVerses: (sectionKey: string) => Promise<VerseRollup[]>
}) {
  const [open, setOpen] = useState(false)
  const [verses, setVerses] = useState<VerseRollup[] | null>(chapter.verses.length > 0 ? chapter.verses : null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (verses != null || loading) return
    setLoading(true)
    setFailed(false)
    try {
      setVerses(await loadVerses(chapter.chapter))
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [chapter.chapter, loadVerses, loading, verses])

  const toggle = useCallback(() => {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) void load()
  }, [load, open])

  return (
    <li>
      <button
        type="button"
        data-testid="chapter-row"
        className="flex w-full items-center gap-2 rounded-sm py-0.5 text-left text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={toggle}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="w-10 shrink-0 text-muted-foreground">Ch {chapter.chapterLabel}</span>
        <MiniRollupBar filledPct={chapter.filledPct} approvedPct={chapter.approvedPct} />
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {chapter.filledCount}/{chapter.approvedCount}/{chapter.cellCount}
        </span>
      </button>
      {open && loading && <p className="ml-5 py-1 text-[10px] text-muted-foreground">Loading verses…</p>}
      {open && failed && (
        <button type="button" className="ml-5 py-1 text-[10px] text-destructive underline" onClick={() => void load()}>
          Verse progress unavailable. Retry
        </button>
      )}
      {open && verses != null && (
        <ul className="ml-5 mt-0.5 mb-1 grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-1" aria-label={`${chapter.chapter} verses`}>
          {verses.map((verse, index) => (
            <AppTooltip key={`${verse.ref}:${index}`} content={verse.ref}>
            <li
              data-testid="verse-cell"
              className={cn(
                "rounded px-1.5 py-0.5 text-center text-[10px] tabular-nums",
                verse.approved ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : verse.filled ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {verse.verseLabel}
            </li>
            </AppTooltip>
          ))}
        </ul>
      )}
    </li>
  )
}

function BookRow({
  book,
  loadVerses,
}: {
  book: BookRollup
  loadVerses: (sectionKey: string) => Promise<VerseRollup[]>
}) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button
        type="button"
        data-testid="book-row"
        className="flex w-full items-center gap-2 py-0.5 text-left text-xs font-medium hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="w-10 shrink-0">{book.book}</span>
        <MiniRollupBar filledPct={book.filledPct} approvedPct={book.approvedPct} />
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {book.filledCount}/{book.approvedCount}/{book.cellCount}
        </span>
      </button>
      {open && (
        <ul className="ml-5 mt-0.5" aria-label={`${book.book} chapters`}>
          {book.chapters.map((c) => (
            <ChapterRow key={c.chapter} chapter={c} loadVerses={loadVerses} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Nested book › chapter progress rollup shown under a file row once expanded,
 * with a flat section fallback for files whose sections are meaningful but
 * not chapter-shaped. Verse progress is fetched separately only when a
 * chapter opens.
 */
function FileCanonicalRollup({
  rollup,
  loading,
  error,
  onRetry,
  loadVerses,
}: {
  rollup: FileRollup | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  loadVerses: (sectionKey: string) => Promise<VerseRollup[]>
}) {
  if (loading) {
    return <p className="ml-7 mt-1 text-xs text-muted-foreground">Loading chapter breakdown…</p>
  }
  if (error) {
    return (
      <button type="button" className="ml-7 mt-1 text-xs text-destructive underline" onClick={onRetry}>
        Chapter progress unavailable. Retry
      </button>
    )
  }
  if (!rollup || (rollup.books === null && rollup.sections.length === 0)) {
    return (
      <p className="ml-7 mt-1 text-xs text-muted-foreground">
        No chapter structure detected for this file.
      </p>
    )
  }
  if (rollup.books === null) {
    return (
      <ul className="ml-7 mt-1 border-l pl-3" data-testid="flat-section-rollup" aria-label="Section breakdown">
        {rollup.sections.map((section) => (
          <FlatSectionRow key={section.key} section={section} />
        ))}
      </ul>
    )
  }
  if (rollup.books.length === 0) return null
  return (
    <ul className="ml-7 mt-1 border-l pl-3" data-testid="canonical-rollup-books" aria-label="Chapter breakdown">
      {rollup.books.map((b) => (
        <BookRow key={b.book} book={b} loadVerses={loadVerses} />
      ))}
    </ul>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProjectOverview() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  // AQU-737: the workspace is a lazy route; surface the load on the Open project
  // button so it spins + disables instead of sitting idle and re-clickable.
  // `openingOverlay` blocks the rest of the page while the open is in flight.
  const { open: openWorkspace, isPending: openPending, overlay: openingOverlay } = useOpenWorkspace()
  const { project, status, refresh, pm } = useProject(id)
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
  const [deadlineDialogOpen, setDeadlineDialogOpen] = useState(false)
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  // AQU-507: PM assignment dialog. `pmSelection` holds the picker value (a
  // stringified userId, or "" for unassigned) while the dialog is open.
  const [pmDialogOpen, setPmDialogOpen] = useState(false)
  const [pmSelection, setPmSelection] = useState<string>("")
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [workload, setWorkload] = useState<AssigneeWorkload[]>([])

  // AQU-538 §3.3: the lane filter pill selection. `null` = "All" — today's
  // cross-lane behavior, byte-identical (StatTiles read the PortfolioProject
  // scalars, file drill-down reads with no lane param). A non-null value is a
  // real lane tag ('' = the default lane) selected from the pill row; the tiles
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
  // default lane pill both map to '' server-side (the default lane == the
  // no-param request), so the drill-down only ever diverges for a selected
  // non-default lane.
  const fileLane = selectedLaneTag ?? ""

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

  // AQU-499: sort/filter controls for the per-file breakdown list. Default
  // sort is last-updated (most-recently-progressed first) per acceptance
  // criteria — a PM opening the overview should see recent activity without
  // configuring anything.
  const [fileSortMode, setFileSortMode] = useState<FileSortMode>("last-updated")
  const [fileNameFilter, setFileNameFilter] = useState("")

  // AQU-500: transient "copied" feedback for the CSV-export control, mirroring
  // the copy-affordance pattern used elsewhere (e.g. ChatMarkdown's code-block
  // copy button).
  const [csvCopied, setCsvCopied] = useState(false)

  // AQU-493/AQU-517: compact progress rollup, lazily fetched per file on
  // first expand. `undefined` = not yet fetched; loaded values choose between
  // canonical book/chapter rows, flat section rows, or a true no-structure note.
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null)
  const [rollups, setRollups] = useState<Record<string, FileRollup>>({})
  const [rollupLoading, setRollupLoading] = useState<Record<string, boolean>>({})
  const [rollupErrors, setRollupErrors] = useState<Record<string, boolean>>({})
  const chapterVerseRequests = useRef(new Map<string, Promise<VerseRollup[]>>())

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

  // AQU-517: expand/collapse a file row's compact server progress. This never
  // downloads cell text or rich HTML.
  const loadFileRollup = useCallback(async (file: FileSummary) => {
    if (!jwt) return
    setRollupLoading((s) => ({ ...s, [file.fileId]: true }))
    setRollupErrors((s) => ({ ...s, [file.fileId]: false }))
    try {
      const tok = await fetchSyncToken(jwt, id, file.fileId, { projectName: project?.name })
      const progress = await getFileProgress(id, file.fileId, async () => tok.token, fileLane)
      setRollups((r) => ({ ...r, [file.fileId]: progressToFileRollup(progress) }))
    } catch (e) {
      console.warn("[ProjectOverview] chapter/verse rollup fetch failed:", e)
      setRollupErrors((s) => ({ ...s, [file.fileId]: true }))
    } finally {
      setRollupLoading((s) => ({ ...s, [file.fileId]: false }))
    }
  }, [jwt, id, project?.name, fileLane])

  const toggleFileRollup = useCallback((file: FileSummary) => {
    if (expandedFileId === file.fileId) {
      setExpandedFileId(null)
      return
    }
    setExpandedFileId(file.fileId)
    if (!(file.fileId in rollups)) void loadFileRollup(file)
  }, [expandedFileId, loadFileRollup, rollups])

  const loadChapterVerses = useCallback((fileId: string, sectionKey: string): Promise<VerseRollup[]> => {
    const cacheKey = `${fileId}:${sectionKey}`
    const existing = chapterVerseRequests.current.get(cacheKey)
    if (existing) return existing
    const request = (async () => {
      if (!jwt) throw new Error("session unavailable")
      const tok = await fetchSyncToken(jwt, id, fileId, { projectName: project?.name })
      const detail = await getFileSectionProgress(id, fileId, sectionKey, async () => tok.token, fileLane)
      return sectionProgressToVerseRollup(detail)
    })().catch((error) => {
      chapterVerseRequests.current.delete(cacheKey)
      throw error
    })
    chapterVerseRequests.current.set(cacheKey, request)
    return request
  }, [id, jwt, project?.name, fileLane])

  // AQU-538 §3.3: the per-file rollup + verse caches are lane-agnostic keys, so
  // switching lanes must drop them (and collapse any open row) — otherwise a
  // re-expand would show the previous lane's chapter/verse breakdown. Resetting
  // on `fileLane` keeps the drill-down lane-true. On first mount fileLane is ''
  // and these are already empty, so this is a no-op for the default view.
  useEffect(() => {
    setExpandedFileId(null)
    setRollups({})
    setRollupLoading({})
    setRollupErrors({})
    chapterVerseRequests.current.clear()
  }, [fileLane])

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

  // AQU-538 §3.3: lane pills + tile recompute. Pills only surface once a project
  // has more than one lane (N=1 stays byte-identical). `activeLane` is the
  // PortfolioLane the pills are filtered to (null = "All"); when set, the
  // Translated/Validated tiles + bars read that lane, and the cross-language
  // tiles (AI Drafted, audio) grey out — they have no per-lane breakdown.
  const projectLanes: PortfolioLane[] = audio?.lanes ?? []
  const showLanePills = projectLanes.length > 1
  const activeLane: PortfolioLane | null =
    selectedLaneTag != null ? projectLanes.find((l) => l.lane === selectedLaneTag) ?? null : null
  const tileTranslatedPct = activeLane ? laneTranslatedPct(activeLane) : audio ? translatedPct(audio) : 0
  const tileValidatedPct = activeLane ? laneValidatedPct(activeLane) : audio ? validatedPct(audio) : 0
  const CROSS_LANE_TOOLTIP = "Cross-language stat — not broken down per language."

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
      // awaited: the PM card above reads useProject, not the directory.
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
      setError("This project has no files to export yet.")
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
      setError(res.message ?? "Only owners can archive a project.")
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
      setError(res.message ?? "Only owners can restore a project.")
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  // Language pair label, e.g. "Greek → Bambara"
  const languagePair =
    project?.sourceLanguage && project?.targetLanguage
      ? `${project.sourceLanguage} → ${project.targetLanguage}`
      : project?.targetLanguage ?? project?.sourceLanguage ?? null

  const nonReadyContent =
    status === "loading" ? (
      <LoadingTemplate
        label="Loading project details"
        className="min-h-[34rem] max-w-5xl"
        data-testid="project-overview-loading"
      >
        <ProjectOverviewSkeleton />
      </LoadingTemplate>
    ) : status === "unreachable" ? (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
        <span className="text-amber-800 dark:text-amber-200">
          Can't reach the server — this project may still be available.
        </span>
        <Button
          type="button"
          onClick={refresh}
          className="shrink-0 bg-amber-800 text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
        >
          Retry
        </Button>
      </div>
    ) : status === "no-session" ? (
      <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
        <p>Sign in to open this project from the cloud.</p>
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          onClick={() => navigate(`/login?next=${encodeURIComponent(`/projects/${id}`)}`)}
        >
          Sign in
        </Button>
      </div>
    ) : null

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={project?.name ?? "Project"} orgId={project?.orgId} />}
      statusBar={null}
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
                          Inactive
                        </Badge>
                      )}
                    </div>
                    {/* Language pair */}
                    {languagePair && (
                      <p className="mt-0.5 text-sm text-muted-foreground">{languagePair}</p>
                    )}
                    <p className="mt-0.5 text-sm text-muted-foreground">{project?.files.length ?? 0} files</p>
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
                          Opening…
                        </>
                      ) : (
                        "Open project"
                      )}
                    </Button>
                    {id && (
                      <Link
                        to={projectSettingsPath(id)}
                        aria-label="Project settings"
                        data-testid="overview-project-settings"
                        className={cn(buttonVariants({ variant: "outline", size: "icon-sm" }), "shrink-0")}
                      >
                        <Settings className="h-4 w-4" />
                      </Link>
                    )}
                    {isOwner && isArchived && (
                      <Button variant="outline" onClick={handleRestore} disabled={busy}>
                        Restore
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
                              aria-label="More actions"
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
                              Download deliverable
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
                              {isFrozen ? "Mark as Active" : "Mark as Inactive"}
                            </DropdownMenuItem>
                          )}
                          {isOwner && (
                            <DropdownMenuItem
                              onClick={() => setArchiveConfirmOpen(true)}
                              disabled={busy}
                              variant="destructive"
                            >
                              <Archive className="size-4" />
                              Archive
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                <ConfirmActionDialog
                  open={archiveConfirmOpen}
                  onOpenChange={setArchiveConfirmOpen}
                  title="Archive project"
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
              {/*
               * SWARM-TODO(AQU-490): verify live — open an oral/dubbed project
               * overview with partial audio validation and confirm the Progress
               * card shows "Has Audio" (coverage, relabeled from "Audio") and a
               * separate "Audio Validated" tile reading "N/A" with a tooltip
               * explaining validation isn't tracked per-medium yet; then open a
               * text-only project and confirm neither audio tile renders (no
               * misleading figure). Blocked on new server work — see the
               * in-card comment above the "Audio Validated" tile for exactly
               * what's missing.
               */}
              {audio && audio.totalCells > 0 && (
                <div className="rounded-lg border bg-card p-5" data-testid="progress-card">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold text-muted-foreground">Progress</h2>
                    <div className="flex items-center gap-1.5">
                      {/* AQU-593: hide stat widgets you don't find helpful. */}
                      {availableStatKeys.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            data-testid="customize-stats-trigger"
                            aria-label="Customize stats"
                            render={
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
                              />
                            }
                          >
                            <SlidersHorizontal className="size-3.5" aria-hidden />
                            Customize
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>Show stats</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {STAT_WIDGETS.filter((w) => availableStatKeys.includes(w.key)).map((w) => (
                                <DropdownMenuCheckboxItem
                                  key={w.key}
                                  checked={statVisible(w.key)}
                                  closeOnClick={false}
                                  onCheckedChange={() => toggleStat(w.key)}
                                  data-testid={`customize-stat-${w.key}`}
                                >
                                  {w.label}
                                </DropdownMenuCheckboxItem>
                              ))}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <SectionVisibilityBadge minRole={ROLE.VIEWER} />
                    </div>
                  </div>

                  {/* AQU-538 §3.3: lane filter pills — All + one per lane
                      (default lane labeled with the project's targetLanguage).
                      Only rendered when the project has >1 lane. */}
                  {showLanePills && (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="lane-filter-pills">
                      <LanePill
                        active={selectedLaneTag === null}
                        onClick={() => setSelectedLaneTag(null)}
                        testId="lane-pill-all"
                      >
                        All
                      </LanePill>
                      {projectLanes.map((l) => {
                        const tagId = l.lane === "" ? "default" : l.lane
                        const label = l.lane === "" ? (project?.targetLanguage || "Default") : l.lane
                        return (
                          <LanePill
                            key={tagId}
                            active={selectedLaneTag === l.lane}
                            onClick={() => setSelectedLaneTag(l.lane)}
                            testId={`lane-pill-${tagId}`}
                          >
                            {label}
                          </LanePill>
                        )
                      })}
                    </div>
                  )}

                  {/* Big-number tiles lead the section */}
                  <div className="flex flex-wrap gap-3 mb-4">
                    {showText && (
                      <>
                        {statVisible("translated") && (
                          <StatTile label="Translated" pct={tileTranslatedPct} colorClass="text-amber-600" />
                        )}
                        {audio.aiDraftedCells > 0 && statVisible("ai-drafted") && (
                          <StatTile
                            label="AI Drafted"
                            pct={aiDraftedPct(audio)}
                            colorClass={activeLane ? "text-muted-foreground/60" : "text-violet-600"}
                            tooltip={activeLane ? CROSS_LANE_TOOLTIP : "Cells drafted by AI (via 'Translate all') that have not yet been human-edited or validated. A human edit or validation will move them into the Translated or Validated counts. Only cells committed after this marker was introduced are tracked — earlier AI commits are indistinguishable from human edits."}
                          />
                        )}
                        {statVisible("validated") && (
                          <StatTile label="Validated" pct={tileValidatedPct} colorClass="text-emerald-600" />
                        )}
                      </>
                    )}
                    {showAudio && (
                      <>
                        {statVisible("has-audio") && (
                          <StatTile
                            label="Has Audio"
                            pct={audioPct(audio)}
                            colorClass={activeLane ? "text-muted-foreground/60" : "text-sky-600"}
                            tooltip={activeLane ? CROSS_LANE_TOOLTIP : "Percentage of cells that have at least one audio recording attached. This is coverage, not validation — see 'Audio Validated' for review status."}
                          />
                        )}
                        {/*
                         * AQU-490 (was TODO(AQU-168)): a distinct audio-VALIDATION metric
                         * is not reachable today. Investigated 2026-07-08:
                         *   - `cells.validated` (db/postgres/schema.sql) is ONE boolean per
                         *     cell, shared by text and audio review — there is no per-medium
                         *     validated flag.
                         *   - `cell_audio` (the per-take audio table) has no
                         *     validated/approved column at all.
                         *   - The `cell.validate` event payload
                         *     (sync-worker/src/events/types.ts) is `{ editEventId }` only —
                         *     no medium/kind field distinguishing "validated the text" from
                         *     "validated the audio".
                         *   - `readValidationCountAudio` (src/lib/progress/read-validation-count.ts)
                         *     is a live, unrelated setting: the *required number of
                         *     validators* for audio-bearing projects, not a count of
                         *     validated audio cells. AQU-298's "possibly dead" flag was
                         *     about a different symbol; this one is alive but doesn't help.
                         * Needs new server work: either a `cell_audio.approved` column (or
                         * equivalent) populated by a medium-aware validate event, or a
                         * `validated_audio_cells` rollup column on `files`/portfolio SQL
                         * analogous to `approved_count`. Until then this is an honest
                         * placeholder, not a fabricated metric.
                         */}
                        {statVisible("audio-validated") && (
                          <StatTile
                            label="Audio Validated"
                            pct={0}
                            display="N/A"
                            colorClass="text-muted-foreground"
                            tooltip="Not tracked yet — the server does not record whether a validation applies to text or audio content (see AQU-490)."
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
                            label="Translated"
                            value={activeLane ? activeLane.filledCells : audio.filledCells}
                            total={activeLane ? activeLane.totalCells : audio.totalCells}
                            fillClass="bg-amber-500"
                            suffix=" cells"
                          />
                        )}
                        {!activeLane && audio.aiDraftedCells > 0 && statVisible("ai-drafted") && (
                          <StatBar
                            label="AI Drafted"
                            value={audio.aiDraftedCells}
                            total={audio.totalCells}
                            fillClass="bg-violet-500"
                            suffix=" cells"
                          />
                        )}
                        {statVisible("validated") && (
                          <StatBar
                            label="Validated"
                            value={activeLane ? activeLane.validatedCells : audio.validatedCells}
                            total={activeLane ? activeLane.totalCells : audio.totalCells}
                            fillClass="bg-emerald-500"
                            suffix=" cells"
                          />
                        )}
                      </>
                    )}
                    {showAudio && !activeLane && statVisible("has-audio") && (
                      <>
                        <StatBar
                          label="Has Audio"
                          value={audio.audioCells}
                          total={audio.totalCells}
                          fillClass="bg-sky-500"
                          suffix=" cells"
                        />
                        {/* TODO: confirm whether legacy GitLab project import populated audio (cell_audio) — see AQU-160 data gap */}
                      </>
                    )}
                  </div>
                  {!activeLane && audio.recordedMs > 0 && statVisible("has-audio") && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {recordedMinutes(audio)} min recorded ·{" "}
                      {Math.round(audioPct(audio) * 100)}% of cells have audio
                    </p>
                  )}
                </div>
              )}

              {/* ── Languages / lane table (AQU-538 §3.3) ── */}
              {/* Rendered only when the project has more than one target
                  language lane — N=1 projects are byte-identical to before. */}
              {showLanePills && audio && (
                <OverviewLaneTable
                  projectId={id}
                  orgId={portfolioOrgId}
                  jwt={jwt}
                  lanes={projectLanes}
                  defaultLanguageLabel={project?.targetLanguage || "Default"}
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
              <ProjectAutopilotPanel
                projectId={id}
                fileNames={autopilotFileNames}
                canStart={(project?.syncRole?.level ?? 0) >= ROLE.CONTRIBUTOR}
              />

              {/* ── Per-file rows (always fully visible per user decision) ── */}
              {files.length > 0 && (() => {
                // AQU-499: filter by name, then sort by the selected mode.
                // Expansion state (rollups/expandedFileId) is keyed by
                // fileId, not row index, so re-sorting/filtering never
                // disturbs an already-expanded row's chapter/verse rollup.
                const filtered = filterFilesByName(files, fileNameFilter)
                const sorted = sortFiles(filtered, fileSortMode)
                const shown = showAllFiles ? sorted : sorted.slice(0, FILE_ROW_CAP)
                const hidden = sorted.length - shown.length

                // AQU-500: export the full sorted+filtered list (honoring
                // AQU-499's current sort/filter), not just the `shown` slice
                // — the FILE_ROW_CAP is a display truncation for readability,
                // not a data filter, so a PM exporting "what I see" should
                // get every row matching their filter/sort, not just the
                // first FILE_ROW_CAP rows.
                async function handleCopyCsv() {
                  const csv = progressRowsToCsv(sorted)
                  try {
                    await navigator.clipboard.writeText(csv)
                    setCsvCopied(true)
                    setTimeout(() => setCsvCopied(false), 1500)
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Couldn't copy to clipboard.")
                  }
                }

                function handleDownloadCsv() {
                  const csv = progressRowsToCsv(sorted)
                  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
                  downloadBlob(blob, progressCsvFilename(project?.name ?? "project"))
                }

                return (
                  <div className="rounded-lg border bg-card p-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-xs font-semibold text-muted-foreground">
                        Files {!showAllFiles && hidden > 0 ? `(top ${FILE_ROW_CAP} of ${sorted.length})` : `(${sorted.length})`}
                      </h2>
                      <span className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-3 rounded-full bg-amber-500" />translated
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-3 rounded-full bg-emerald-500" />validated
                        </span>
                      </span>
                    </div>
                    {/*
                      SWARM-TODO(AQU-500): verify live — as a role WITH the org's
                      export permission, open a Scripture project overview,
                      change the file sort/filter (AQU-499), then click "Copy
                      CSV" and paste into a spreadsheet: confirm the rows/columns
                      match on-screen (file, filled, approved, total, words) in
                      the same order as the table, and that a file name with a
                      comma/quote lands in one cell correctly. Click "Download
                      CSV" and confirm the .csv opens with the same rows. Then,
                      as a role WITHOUT the org's export permission (org
                      settings → exportMinRole set above that role), confirm
                      neither Copy CSV nor Download CSV control renders.
                    */}
                    {orgSettings.canExport && sorted.length > 0 && (
                      <div className="mb-3 flex items-center gap-2">
                        <AppTooltip content="Copy the file list below as CSV">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleCopyCsv()}
                            data-testid="export-csv-copy"
                          >
                            {csvCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                            {csvCopied ? "Copied" : "Copy CSV"}
                          </Button>
                        </AppTooltip>
                        <AppTooltip content="Download the file list below as a .csv file">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleDownloadCsv}
                            data-testid="export-csv-download"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download CSV
                          </Button>
                        </AppTooltip>
                      </div>
                    )}
                    {/*
                      SWARM-TODO(AQU-499): verify live — open a Scripture
                      project overview, change the "Sort files by" dropdown
                      to "Canonical order" and confirm Genesis-before-Exodus
                      (and OT-before-NT) row order; switch to "Alphabetical"
                      and confirm plain name order; type into the filter box
                      and confirm rows narrow to matching file names; expand
                      a file's chapter/verse rollup (AQU-493), change sort,
                      and confirm the same file's rollup is still expanded
                      after its row moves.
                    */}
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <InputGroup className="h-9 max-w-56">
                        <InputGroupAddon>
                          <Search />
                        </InputGroupAddon>
                        <InputGroupInput
                          type="text"
                          placeholder="Filter files by name…"
                          aria-label="Filter files by name"
                          value={fileNameFilter}
                          onChange={(e) => setFileNameFilter(e.target.value)}
                        />
                      </InputGroup>
                      <Select
                        items={FILE_SORT_MODES}
                        value={fileSortMode}
                        onValueChange={(v) => setFileSortMode((v as FileSortMode) ?? "last-updated")}
                      >
                        <SelectTrigger aria-label="Sort files by">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {FILE_SORT_MODES.map((m) => (
                              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    {sorted.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No files match “{fileNameFilter}”.</p>
                    ) : (
                    <>
                      {/*
                        AQU-492: two-level layout — a header row labels each
                        numeric column once, so per-row values (below) never
                        need to be re-explained. Header and row cell widths
                        must stay in lockstep (same width + gap classes) for
                        the columns to line up; the tooltip on each row is
                        kept as a redundant, not load-bearing, explainer.
                      */}
                      <div
                        className="mb-1.5 flex items-center gap-3 text-xs font-medium text-muted-foreground"
                        data-testid="file-breakdown-header"
                      >
                        <span className="w-5 shrink-0" />
                        <span className="w-32 shrink-0">File</span>
                        <span className="flex-1">Progress</span>
                        <span className="flex shrink-0 items-center gap-4">
                          <span className="w-10 text-right">Filled</span>
                          <span className="w-14 text-right">Approved</span>
                          <span className="w-10 text-right">Total</span>
                          <span className="w-12 text-right">Words</span>
                        </span>
                      </div>
                      <ul className="space-y-2" aria-label="Files">
                        {shown.map((f) => {
                          const tPct = f.cellCount > 0 ? Math.round((f.filledCount / f.cellCount) * 100) : 0
                          const vPct = f.cellCount > 0 ? Math.round((f.approvedCount / f.cellCount) * 100) : 0
                          const isExpanded = expandedFileId === f.fileId
                          return (
                            <li key={f.fileId} data-testid="file-row">
                              <div className="flex items-center gap-3 text-sm">
                                <button
                                  type="button"
                                  aria-label={isExpanded ? `Collapse ${f.name}` : `Expand ${f.name}`}
                                  aria-expanded={isExpanded}
                                  onClick={() => void toggleFileRollup(f)}
                                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                                >
                                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                                </button>
                                {/* AQU-491: full name was hover-only (tooltip); ExpandableName
                                    adds a click-to-reveal Popover so a truncated file name is
                                    discoverable without hovering. Tooltip kept for parity/hover
                                    users; both read from the same fixed w-32 column. */}
                                <AppTooltip content={f.name}>
                                  <span className="w-32 shrink-0 text-sm font-medium">
                                    <ExpandableName name={f.name} />
                                  </span>
                                </AppTooltip>
                                <FileProgressBars tPct={tPct} vPct={vPct} />
                                <AppTooltip content="Cells filled / cells approved / total cells · word count">
                                  <span
                                    className="flex shrink-0 items-center gap-4 text-xs tabular-nums text-muted-foreground"
                                    aria-label={`${f.filledCount} filled, ${f.approvedCount} approved, ${f.cellCount} total cells, ${f.wordCount} words`}
                                  >
                                    <span className="w-10 text-right">{f.filledCount}</span>
                                    <span className="w-14 text-right">{f.approvedCount}</span>
                                    <span className="w-10 text-right">{f.cellCount}</span>
                                    <span className="w-12 text-right">{f.wordCount}</span>
                                  </span>
                                </AppTooltip>
                              </div>
                              {isExpanded && (
                                <FileCanonicalRollup
                                  rollup={rollups[f.fileId]}
                                  loading={rollupLoading[f.fileId] ?? false}
                                  error={rollupErrors[f.fileId] ?? false}
                                  onRetry={() => void loadFileRollup(f)}
                                  loadVerses={(sectionKey) => loadChapterVerses(f.fileId, sectionKey)}
                                />
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </>
                    )}
                    {!showAllFiles && hidden > 0 && (
                      <button
                        className="mt-3 text-xs text-muted-foreground hover:text-foreground underline"
                        onClick={() => setShowAllFiles(true)}
                      >
                        +{hidden} more files — show all
                      </button>
                    )}
                    {showAllFiles && sorted.length > FILE_ROW_CAP && (
                      <button
                        className="mt-3 text-xs text-muted-foreground hover:text-foreground underline"
                        onClick={() => setShowAllFiles(false)}
                      >
                        Show fewer
                      </button>
                    )}
                  </div>
                )
              })()}

              {/* ── Deadline card ── */}
              <div className="rounded-lg border bg-card p-5">
                <h2 className="mb-2 text-xs font-semibold text-muted-foreground">Deadline</h2>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {audio?.deadlineAt ? (
                    <span className="flex items-center gap-2 font-medium">
                      {audio.deadlineAt}
                      <DeadlineChip status={dstatus} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No deadline set</span>
                  )}
                  {canManage && (
                    <ButtonGroup>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setDeadlineDate(deadlineStringToDate(audio?.deadlineAt))
                          setDeadlineDialogOpen(true)
                        }}
                      >
                        {audio?.deadlineAt ? "Change" : "Set deadline"}
                      </Button>
                      {audio?.deadlineAt && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => saveDeadline(null)}
                        >
                          Clear
                        </Button>
                      )}
                    </ButtonGroup>
                  )}
                </div>
              </div>

              <Dialog open={deadlineDialogOpen} onOpenChange={setDeadlineDialogOpen}>
                <DialogContent className="sm:max-w-sm">
                  <DialogHeader>
                    <DialogTitle>
                      {audio?.deadlineAt ? "Change project deadline" : "Set project deadline"}
                    </DialogTitle>
                    <DialogDescription>
                      The deadline is inclusive through the end of that day anywhere on Earth.
                    </DialogDescription>
                  </DialogHeader>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="project-deadline">Deadline date</FieldLabel>
                      <DatePicker
                        id="project-deadline"
                        value={deadlineDate}
                        onChange={setDeadlineDate}
                        disabled={busy}
                        placeholder="July 03, 2026"
                      />
                    </Field>
                  </FieldGroup>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDeadlineDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || !deadlineDate}
                      onClick={() => saveDeadline(deadlineDate ? dateToDeadlineString(deadlineDate) : null)}
                    >
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* ── Project manager card (AQU-507) ── */}
              <div className="rounded-lg border bg-card p-5">
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Project manager</h2>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {pm ? (
                    <UsernameWithAvatar username={pm.username} nameTestId="overview-pm-name" />
                  ) : (
                    <span className="text-muted-foreground" data-testid="overview-pm-name">Unassigned</span>
                  )}
                  {canManage && (
                    <ButtonGroup>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        data-testid="overview-pm-edit"
                        onClick={() => {
                          setPmSelection(pm ? String(pm.id) : "")
                          setPmDialogOpen(true)
                        }}
                      >
                        {pm ? "Change" : "Assign"}
                      </Button>
                      {pm && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => savePm(null)}
                        >
                          Clear
                        </Button>
                      )}
                    </ButtonGroup>
                  )}
                </div>
              </div>

              <Dialog open={pmDialogOpen} onOpenChange={setPmDialogOpen}>
                <DialogContent className="sm:max-w-sm">
                  <DialogHeader>
                    <DialogTitle>{pm ? "Change project manager" : "Assign project manager"}</DialogTitle>
                    <DialogDescription>
                      The project manager is responsible for this project. They must be a member
                      of the project.
                    </DialogDescription>
                  </DialogHeader>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="project-pm">Project manager</FieldLabel>
                      {/* `items` maps values → labels so the trigger shows the
                          member's username, not the raw stringified userId. */}
                      <Select
                        value={pmSelection}
                        onValueChange={(v) => setPmSelection(v ?? "")}
                        items={[
                          { value: "", label: "Unassigned" },
                          ...pmCandidates.map((m) => ({
                            value: String(m.userId),
                            label: m.username,
                          })),
                        ]}
                      >
                        <SelectTrigger id="project-pm" aria-label="Project manager">
                          <SelectValue placeholder="Select a member" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="">Unassigned</SelectItem>
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
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setPmDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => savePm(pmSelection === "" ? null : Number(pmSelection))}
                    >
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

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
                    <h2 className="text-xs font-semibold text-muted-foreground">Team</h2>
                    <SectionVisibilityBadge
                      minRole={orgSettings.memberProgressViewMinRole}
                      canEdit={canEditVisibility}
                      onChangeMinRole={async (next) => { await orgSettings.patch({ memberProgressViewMinRole: next }) }}
                      description="Who can see each teammate's assignment progress on this project."
                    />
                  </div>
                  {workload.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No open assignments in this project yet.</p>
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
                                  name={w.username ?? `User ${w.userId}`}
                                  size="sm"
                                  singleInitial
                                  className="shrink-0"
                                />
                                <ExpandableName name={w.username ?? `User ${w.userId}`} />
                              </span>
                            </AppTooltip>
                            <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${donePct}%` }} />
                            </span>
                            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                              {w.openAssignments} open · {donePct}%
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
                                aria-label={`View activity for ${w.username}`}
                                aria-pressed={isSelected}
                                onClick={() => setSelectedMemberUsername(isSelected ? null : (w.username as string))}
                              >
                                {isSelected ? "Hide" : "Activity"}
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

              {/* ── Members card (AQU-335) — same add / change-role / revoke
                  surface as Project Settings → Team members, so access can be
                  managed from the overview without opening settings. ──
                  AQU-486: gated by AQU-485's rosterViewMinRole — the same
                  policy MembersTab itself enforces server-side (see its
                  "Roster hidden" state), applied here one layer up so a
                  below-floor caller never sees the card shell at all. */}
              {canManage && !isArchived && (
                <SectionVisibilityGate
                  minRole={orgSettings.rosterViewMinRole}
                  viewerRoleLevel={projectRoleLevel}
                  ready={orgSettings.hasFetched}
                >
                  <div
                    className={cn("relative rounded-lg border bg-card p-5", sectionTintClass(orgSettings.rosterViewMinRole))}
                    data-testid="overview-members-card"
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="text-xs font-semibold text-muted-foreground">Members</h2>
                      <SectionVisibilityBadge
                        minRole={orgSettings.rosterViewMinRole}
                        canEdit={canEditVisibility}
                        onChangeMinRole={async (next) => { await orgSettings.patch({ rosterViewMinRole: next }) }}
                        description="Who can see the member roster on this project."
                      />
                    </div>
                    <MembersTab projectId={id} className="space-y-6" />
                  </div>
                </SectionVisibilityGate>
              )}
            </div>
          )}
          </div>
        </div>
      }
    />
  )
}
