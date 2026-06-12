import { useState, useEffect, useCallback, useRef } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
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
import { fetchProjectFiles, type FileSummary } from "@/lib/sync/cells-read"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { getProjectAssignments, type AssigneeWorkload } from "@/lib/sync/assignments"
import { Badge } from "@/components/ui/badge"

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
  return (
    <div className="flex flex-col items-center rounded-lg bg-muted/40 px-5 py-3 text-center" title={tooltip}>
      <p className={`text-2xl font-bold tabular-nums ${colorClass}`}>{Math.round(pct * 100)}%</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
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
        <span className="h-2 flex-1 rounded-full bg-muted overflow-hidden shadow-neu-inset">
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
      <span className="block h-1.5 rounded-full bg-muted overflow-hidden shadow-neu-inset">
        <span className="block h-full rounded-full bg-amber-500 transition-all" style={{ width: `${tPct}%` }} />
      </span>
      <span className="block h-1.5 rounded-full bg-muted overflow-hidden shadow-neu-inset">
        <span className="block h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${vPct}%` }} />
      </span>
    </span>
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
      <button
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border px-2.5 py-1.5 text-sm font-medium hover:bg-accent/40"
      >
        ⋯
      </button>
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
  const [editingDeadline, setEditingDeadline] = useState(false)
  const [deadlineInput, setDeadlineInput] = useState("")
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [workload, setWorkload] = useState<AssigneeWorkload[]>([])

  const loadRow = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    try {
      const list = await getPortfolio(jwt, activeOrgId)
      setAudio(list.find((p) => p.id === id) ?? null)
    } catch {
      setAudio(null)
    }
  }, [jwt, activeOrgId, id])

  useEffect(() => {
    void loadRow()
  }, [loadRow])

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
      setEditingDeadline(false)
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
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="max-w-5xl space-y-4">
              {/* ── Header card ── */}
              <div className="rounded-xl border bg-card shadow-sm p-6">
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
                  <div className="flex shrink-0 gap-2 items-start">
                    <button
                      onClick={() => navigate(`/project/${id}`)}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                    >
                      Open project
                    </button>
                    {isOwner && isArchived && (
                      <button
                        onClick={handleRestore}
                        disabled={busy}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
                      >
                        Restore
                      </button>
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
              {audio && audio.totalCells > 0 && (
                <div className="rounded-xl border bg-card shadow-sm p-5">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Progress</h2>

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
                const sorted = [...files].sort((a, b) => b.cellCount - a.cellCount)
                const shown = showAllFiles ? sorted : sorted.slice(0, FILE_ROW_CAP)
                const hidden = sorted.length - shown.length
                return (
                  <div className="rounded-xl border bg-card shadow-sm p-5">
                    <div className="mb-3 flex items-center justify-between">
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
                    <ul className="space-y-2">
                      {shown.map((f) => {
                        const tPct = f.cellCount > 0 ? Math.round((f.filledCount / f.cellCount) * 100) : 0
                        const vPct = f.cellCount > 0 ? Math.round((f.approvedCount / f.cellCount) * 100) : 0
                        return (
                          <li key={f.fileId} className="flex items-center gap-3 text-sm">
                            <span className="w-36 shrink-0 truncate text-sm font-medium" title={f.name}>{f.name}</span>
                            <FileProgressBars tPct={tPct} vPct={vPct} />
                            <span
                              className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                              title="filled / approved / total cells · word count"
                            >
                              {f.filledCount}/{f.approvedCount}/{f.cellCount} · {f.wordCount}w
                            </span>
                          </li>
                        )
                      })}
                    </ul>
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
              <div className="rounded-xl border bg-card shadow-sm p-5">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deadline</h2>
                {editingDeadline ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      value={deadlineInput}
                      onChange={(e) => setDeadlineInput(e.target.value)}
                      disabled={busy}
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      aria-label="Project deadline"
                    />
                    <button
                      onClick={() => saveDeadline(deadlineInput || null)}
                      disabled={busy || !deadlineInput}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent/40 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingDeadline(false)}
                      disabled={busy}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent/40 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
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
                      <>
                        <button
                          onClick={() => { setDeadlineInput(audio?.deadlineAt ?? ""); setEditingDeadline(true) }}
                          disabled={busy}
                          className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent/40 disabled:opacity-50"
                        >
                          {audio?.deadlineAt ? "Change" : "Set deadline"}
                        </button>
                        {audio?.deadlineAt && (
                          <button
                            onClick={() => saveDeadline(null)}
                            disabled={busy}
                            className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent/40 disabled:opacity-50"
                          >
                            Clear
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* ── Team / Assignments card ── */}
              <div className="rounded-xl border bg-card shadow-sm p-5">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team</h2>
                {workload.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open assignments in this project yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {workload.map((w) => {
                      const donePct = w.cellsTotal > 0 ? Math.round((w.cellsDone / w.cellsTotal) * 100) : 0
                      return (
                        <li key={w.userId} className="flex items-center gap-3 text-sm">
                          <span className="w-32 shrink-0 font-medium truncate" title={w.username ?? String(w.userId)}>
                            {w.username ?? `User ${w.userId}`}
                          </span>
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

              {/* ── Members card (FRO-335) — same add / change-role / revoke
                  surface as the in-project members page, so access can be
                  managed from the overview without opening the workspace. ── */}
              {canManage && !isArchived && (
                <div className="rounded-xl border bg-card shadow-sm p-5" data-testid="overview-members-card">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
                  <MembersTab projectId={id} className="space-y-6" />
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      }
    />
  )
}
