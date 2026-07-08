import { useState, useEffect, useCallback, useRef } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { MoreHorizontal, ChevronRight } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import { archiveProjectRemote, unarchiveProjectRemote } from "@/lib/sync/archive"
import { setProjectDeadline } from "@/lib/sync/cloud-projects"
import { useProjectLifecycle } from "@/hooks/useProjectLifecycle"
import { InactiveProjectBanner } from "@/components/InactiveProjectBanner"
import { downloadProjectBundle } from "@/lib/sync/export-bundle"
import { AssignWork } from "./AssignWork"
import { MembersTab } from "@/components/ProjectMembersPage"
import { getPortfolio, translatedPct, validatedPct, aiDraftedPct, audioPct, recordedMinutes, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"
import { fetchProjectFiles, fetchAllFileCells, type FileSummary } from "@/lib/sync/cells-read"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { buildCanonicalRollup, type BookRollup, type ChapterRollup } from "@/lib/progress/canonical-rollup"
import { sortFiles, filterFilesByName, FILE_SORT_MODES, type FileSortMode } from "@/lib/progress/file-sort"
import { getProjectAssignments, type AssigneeWorkload } from "@/lib/sync/assignments"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ROLE } from "@/lib/frontier/roles"
import {
  SectionVisibilityBadge,
  SectionVisibilityGate,
  sectionTintClass,
} from "./SectionVisibilityBadge"
import { Badge } from "@/components/ui/badge"
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** Max per-file rows shown on the overview; the rest are counted as "+N more". */
const FILE_ROW_CAP = 12

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
  if (status === "no-deadline") return null
  const map: Record<Exclude<ProjectStatus, "no-deadline">, { label: string; cls: string }> = {
    "on-track": { label: "On track", cls: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
    "due-soon": { label: "Due soon", cls: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
    "overdue":  { label: "Overdue",  cls: "border-transparent bg-destructive/10 text-destructive" },
  }
  const { label, cls } = map[status as Exclude<ProjectStatus, "no-deadline">]
  return (
    <Badge className={cls} data-testid="status-chip">
      {label}
    </Badge>
  )
}

// ── Deadline chip ─────────────────────────────────────────────────────────────

function DeadlineChip({ status }: { status: "overdue" | "soon" | "ok" | null }) {
  if (!status) return null
  const map = {
    ok:      { cls: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
    soon:    { cls: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
    overdue: { cls: "border-transparent bg-destructive/10 text-destructive" },
  }
  return <Badge className={map[status].cls}>{status === "overdue" ? "Overdue" : status === "soon" ? "Due soon" : "On track"}</Badge>
}

// ── Stat tiles (big %) ────────────────────────────────────────────────────────

function StatTile({ label, pct, colorClass, tooltip }: { label: string; pct: number; colorClass: string; tooltip?: string }) {
  const tile = (
    <div className="flex flex-col items-center rounded-lg bg-muted/40 px-5 py-3 text-center">
      <p className={`text-2xl font-bold tabular-nums ${colorClass}`}>{Math.round(pct * 100)}%</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
  return tooltip ? <AppTooltip content={tooltip}>{tile}</AppTooltip> : tile
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

function ChapterRow({ chapter }: { chapter: ChapterRollup }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button
        type="button"
        data-testid="chapter-row"
        className="flex w-full items-center gap-2 py-0.5 text-left text-xs hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="w-10 shrink-0 text-muted-foreground">Ch {chapter.chapterLabel}</span>
        <MiniRollupBar filledPct={chapter.filledPct} approvedPct={chapter.approvedPct} />
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {chapter.filledCount}/{chapter.approvedCount}/{chapter.cellCount}
        </span>
      </button>
      {open && (
        <ul className="ml-5 mt-0.5 mb-1 grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-1" aria-label={`${chapter.chapter} verses`}>
          {chapter.verses.map((v) => (
            <li
              key={v.ref}
              data-testid="verse-cell"
              title={v.ref}
              className={cn(
                "rounded px-1.5 py-0.5 text-center text-[10px] tabular-nums",
                v.approved ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : v.filled ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {v.verseLabel}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function BookRow({ book }: { book: BookRollup }) {
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
            <ChapterRow key={c.chapter} chapter={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Nested book › chapter › verse progress rollup shown under a file row once
 * expanded. `books === null` means the file's cells carry no parseable
 * canonical reference (AQU-493 detection is generic — see
 * lib/progress/canonical-rollup.ts) — render an explanatory note instead of
 * an empty tree, per the acceptance criteria.
 *
 * SWARM-TODO(AQU-493): verify live — open a Scripture project overview,
 * click a file row's chevron to expand it, confirm chapter rows appear and
 * their filled/approved counts sum to the file row's totals, then drill
 * into a chapter to see the per-verse grid.
 */
function FileCanonicalRollup({ books, loading }: { books: BookRollup[] | null | undefined; loading: boolean }) {
  if (loading) {
    return <p className="ml-7 mt-1 text-xs text-muted-foreground">Loading chapter/verse breakdown…</p>
  }
  if (books === null) {
    return (
      <p className="ml-7 mt-1 text-xs text-muted-foreground">
        No chapter/verse structure detected for this file.
      </p>
    )
  }
  if (books === undefined || books.length === 0) return null
  return (
    <ul className="ml-7 mt-1 border-l pl-3" data-testid="canonical-rollup-books" aria-label="Chapter/verse breakdown">
      {books.map((b) => (
        <BookRow key={b.book} book={b} />
      ))}
    </ul>
  )
}

// ── Overflow menu (archive / download) ───────────────────────────────────────

function OverflowMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-40 rounded-md border bg-popover shadow-md py-1">
          {children}
        </div>
      )}
    </div>
  )
}

function OverflowItem({ onClick, disabled, className, children }: {
  onClick: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent/40 disabled:opacity-50 ${className ?? ""}`}
    >
      {children}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProjectOverview() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { project, status, refresh } = useProject(id)
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { activeOrgId } = useActiveOrg()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audio, setAudio] = useState<PortfolioProject | null>(null)
  const [files, setFiles] = useState<FileSummary[]>([])
  const [deadlineDialogOpen, setDeadlineDialogOpen] = useState(false)
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [workload, setWorkload] = useState<AssigneeWorkload[]>([])

  // AQU-499: sort/filter controls for the per-file breakdown list. Default
  // sort is last-updated (most-recently-progressed first) per acceptance
  // criteria — a PM opening the overview should see recent activity without
  // configuring anything.
  const [fileSortMode, setFileSortMode] = useState<FileSortMode>("last-updated")
  const [fileNameFilter, setFileNameFilter] = useState("")

  // AQU-493: chapter/verse rollup, lazily fetched per file on first expand.
  // `undefined` = not yet fetched, `null` = fetched but no canonical refs
  // found (flat-view fallback), `BookRollup[]` = ready to render.
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null)
  const [rollups, setRollups] = useState<Record<string, BookRollup[] | null>>({})
  const [rollupLoading, setRollupLoading] = useState<Record<string, boolean>>({})

  // FRO-474: project-only invitees (direct project_members grant, no org
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
  // mismatch alone (pre-FRO-474 behavior) sent guests right back to "/".
  useEffect(() => {
    // FRO-346: "forbidden" (access revoked) leaves the overview the same way
    // a missing project does — back to the dashboard.
    if (status === "not-found" || status === "forbidden") {
      navigate("/", { replace: true })
    }
  }, [status, navigate])

  // Load per-project assignment roster for the Team card (maintainer+)
  useEffect(() => {
    if (!jwt || !id) return
    getProjectAssignments(jwt, id)
      .then(setWorkload)
      .catch(() => setWorkload([]))
  }, [jwt, id])

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

  // AQU-493: expand/collapse a file row's chapter/verse rollup. Fetches the
  // file's full cell set (paired source+target) once per file, on demand —
  // the aggregate `/files` rollup used above has no per-cell reference data,
  // so this is a separate lazy fetch scoped to whichever file is expanded.
  const toggleFileRollup = useCallback(async (file: FileSummary) => {
    if (expandedFileId === file.fileId) {
      setExpandedFileId(null)
      return
    }
    setExpandedFileId(file.fileId)
    if (file.fileId in rollups || !jwt) return
    setRollupLoading((s) => ({ ...s, [file.fileId]: true }))
    try {
      const tok = await fetchSyncToken(jwt, id, file.fileId, { projectName: project?.name })
      const rows = await fetchAllFileCells(id, file.fileId, tok.token)
      setRollups((r) => ({ ...r, [file.fileId]: buildCanonicalRollup(rows) }))
    } catch (e) {
      console.warn("[ProjectOverview] chapter/verse rollup fetch failed:", e)
      setRollups((r) => ({ ...r, [file.fileId]: null }))
    } finally {
      setRollupLoading((s) => ({ ...s, [file.fileId]: false }))
    }
  }, [expandedFileId, rollups, jwt, id, project?.name])

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
      navigate("/projects")
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
      <p className="text-sm text-muted-foreground">Loading…</p>
    ) : status === "unreachable" ? (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
        <span className="text-amber-800 dark:text-amber-200">
          Can't reach the server — this project may still be available.
        </span>
        <Button
          type="button"
          size="sm"
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
          size="sm"
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
      header={<OrgBreadcrumb section={project?.name ?? "Project"} />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto">
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
              <div className="rounded-xl border bg-card p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-xl font-semibold leading-tight truncate">{project?.name}</h1>
                      {/* Compact status chip next to the title */}
                      <StatusChip status={projectStatus} />
                      {isArchived && (
                        <Badge variant="secondary" className="shrink-0">Archived</Badge>
                      )}
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
                    <Button size="sm" onClick={() => navigate(`/project/${id}`)}>
                      Open project
                    </Button>
                    {isOwner && isArchived && (
                      <Button size="sm" variant="outline" onClick={handleRestore} disabled={busy}>
                        Restore
                      </Button>
                    )}
                    {/* Archive + Download + Lifecycle moved into overflow menu */}
                    {(canManage || isOwner || canToggleLifecycle) && !isArchived && (
                      <OverflowMenu>
                        {canManage && (
                          <OverflowItem
                            onClick={handleDownloadBundle}
                            disabled={busy || (project?.files.length ?? 0) === 0}
                          >
                            Download deliverable
                          </OverflowItem>
                        )}
                        {canToggleLifecycle && (
                          <OverflowItem
                            onClick={handleToggleLifecycle}
                            disabled={lifecycleBusy}
                          >
                            {isFrozen ? "Mark as Active" : "Mark as Inactive"}
                          </OverflowItem>
                        )}
                        {isOwner && (
                          <OverflowItem
                            onClick={handleArchive}
                            disabled={busy}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            Archive
                          </OverflowItem>
                        )}
                      </OverflowMenu>
                    )}
                  </div>
                </div>

                {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
              </div>

              {/* ── Progress card ── */}
              {/* AQU-486: progress has no configurable floor today — everyone
                  with project access can see it. The badge is read-only
                  (informational), matching that reality rather than implying
                  a toggle that doesn't exist server-side. */}
              {audio && audio.totalCells > 0 && (
                <div className="rounded-xl border bg-card p-5">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Progress</h2>
                    <SectionVisibilityBadge minRole={ROLE.VIEWER} />
                  </div>

                  {/* Big-number tiles lead the section */}
                  <div className="flex flex-wrap gap-3 mb-4">
                    {showText && (
                      <>
                        <StatTile label="Translated" pct={translatedPct(audio)} colorClass="text-amber-600" />
                        {audio.aiDraftedCells > 0 && (
                          <StatTile
                            label="AI Drafted"
                            pct={aiDraftedPct(audio)}
                            colorClass="text-violet-600"
                            tooltip="Cells drafted by AI (via 'Translate all') that have not yet been human-edited or validated. A human edit or validation will move them into the Translated or Validated counts. Only cells committed after this marker was introduced are tracked — earlier AI commits are indistinguishable from human edits."
                          />
                        )}
                        <StatTile label="Validated" pct={validatedPct(audio)} colorClass="text-emerald-600" />
                      </>
                    )}
                    {showAudio && (
                      <StatTile label="Audio" pct={audioPct(audio)} colorClass="text-sky-600" />
                    )}
                    {/* TODO(FRO-168): audio VALIDATION metric — need audioCells with approved-audio count from server */}
                  </div>

                  {/* Detail bars below tiles */}
                  <div className="space-y-2.5">
                    {showText && (
                      <>
                        <StatBar
                          label="Translated"
                          value={audio.filledCells}
                          total={audio.totalCells}
                          fillClass="bg-amber-500"
                          suffix=" cells"
                        />
                        {audio.aiDraftedCells > 0 && (
                          <StatBar
                            label="AI Drafted"
                            value={audio.aiDraftedCells}
                            total={audio.totalCells}
                            fillClass="bg-violet-500"
                            suffix=" cells"
                          />
                        )}
                        <StatBar
                          label="Validated"
                          value={audio.validatedCells}
                          total={audio.totalCells}
                          fillClass="bg-emerald-500"
                          suffix=" cells"
                        />
                      </>
                    )}
                    {showAudio && (
                      <>
                        <StatBar
                          label="Audio"
                          value={audio.audioCells}
                          total={audio.totalCells}
                          fillClass="bg-sky-500"
                          suffix=" cells"
                        />
                        {/* TODO: confirm whether legacy GitLab project import populated audio (cell_audio) — see FRO-160 data gap */}
                      </>
                    )}
                  </div>
                  {audio.recordedMs > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {recordedMinutes(audio)} min recorded ·{" "}
                      {Math.round(audioPct(audio) * 100)}% of cells have audio
                    </p>
                  )}
                </div>
              )}

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
                return (
                  <div className="rounded-xl border bg-card p-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
                      <Input
                        type="text"
                        placeholder="Filter files by name…"
                        aria-label="Filter files by name"
                        value={fileNameFilter}
                        onChange={(e) => setFileNameFilter(e.target.value)}
                        className="max-w-56"
                      />
                      <Select
                        items={FILE_SORT_MODES}
                        value={fileSortMode}
                        onValueChange={(v) => setFileSortMode((v as FileSortMode) ?? "last-updated")}
                      >
                        <SelectTrigger aria-label="Sort files by" className="w-44">
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
                              <AppTooltip content={f.name}>
                                <span className="w-32 shrink-0 truncate text-sm font-medium">{f.name}</span>
                              </AppTooltip>
                              <FileProgressBars tPct={tPct} vPct={vPct} />
                              <AppTooltip content="filled / approved / total cells · word count">
                                <span className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                  {f.filledCount}/{f.approvedCount}/{f.cellCount} · {f.wordCount}w
                                </span>
                              </AppTooltip>
                            </div>
                            {isExpanded && (
                              <FileCanonicalRollup books={rollups[f.fileId]} loading={rollupLoading[f.fileId] ?? false} />
                            )}
                          </li>
                        )
                      })}
                    </ul>
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
              <div className="rounded-xl border bg-card p-5">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deadline</h2>
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
                        size="sm"
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
                          size="sm"
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
                <div className={cn("relative rounded-xl border bg-card p-5", sectionTintClass(orgSettings.memberProgressViewMinRole))}>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team</h2>
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
                        return (
                          <li key={w.userId} className="flex items-center gap-3 text-sm">
                            <AppTooltip content={w.username ?? String(w.userId)}>
                              <span className="w-32 shrink-0 font-medium truncate">
                                {w.username ?? `User ${w.userId}`}
                              </span>
                            </AppTooltip>
                            <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${donePct}%` }} />
                            </span>
                            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                              {w.openAssignments} open · {donePct}%
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  {canAssign && !isArchived && activeOrgId != null && (project?.files.length ?? 0) > 0 && (
                    <div className="mt-3 pt-3 border-t">
                      <AssignWork
                        projectId={id}
                        files={project?.files ?? []}
                        orgId={activeOrgId}
                        jwt={jwt ?? ""}
                        author={session?.username ?? ""}
                        onAssigned={loadRow}
                      />
                    </div>
                  )}
                </div>
              </SectionVisibilityGate>

              {/* ── Members card (FRO-335) — same add / change-role / revoke
                  surface as the in-project members page, so access can be
                  managed from the overview without opening the workspace. ──
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
                    className={cn("relative rounded-xl border bg-card p-5", sectionTintClass(orgSettings.rosterViewMinRole))}
                    data-testid="overview-members-card"
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
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
