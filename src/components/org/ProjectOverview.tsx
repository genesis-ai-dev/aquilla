import { useState, useEffect, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import { archiveProjectRemote, unarchiveProjectRemote } from "@/lib/sync/archive"
import { setProjectDeadline } from "@/lib/sync/cloud-projects"
import { downloadProjectBundle } from "@/lib/sync/export-bundle"
import { AssignWork } from "./AssignWork"
import { getPortfolio, translatedPct, validatedPct, audioPct, recordedMinutes, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"
import { fetchProjectFiles, type FileSummary } from "@/lib/sync/cells-read"
import { fetchSyncToken } from "@/lib/sync/sync-token"

/** Max per-file rows shown on the overview; the rest are counted as "+N more". */
const FILE_ROW_CAP = 12

/** A labeled progress bar matching the FileRow neumorphic bar style. */
function StatBar({ label, value, total, fillClass, suffix }: {
  label: string
  value: number
  total: number
  fillClass: string
  suffix?: string
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="h-2 flex-1 rounded-full bg-muted overflow-hidden shadow-neu-inset">
        <span className={`block h-full rounded-full ${fillClass}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {pct}% · {value}/{total}{suffix ?? ""}
      </span>
    </div>
  )
}

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

  // Per-file rollups live on the sync-worker, which needs a project-scoped
  // sync token (the raw session JWT is rejected). Mint one via the project's
  // first file, then list every file's counters.
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
  const isArchived = Boolean(project?.deletedAt)
  const dstatus = audio ? deadlineStatus(audio, Date.now()) : null

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

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={project?.name ?? "Project"} />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6">
          {status !== "ready" ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="max-w-xl rounded-lg border p-6">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{project?.name}</h1>
                {isArchived && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Archived</span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{project?.files.length ?? 0} files</p>

              {/* Project-level progress: translated (has a draft), validated,
                  and audio — the three signals a manager scans at a glance. */}
              {audio && audio.totalCells > 0 && (
                <div className="mt-3 space-y-1.5">
                  <StatBar
                    label="Translated"
                    value={audio.filledCells}
                    total={audio.totalCells}
                    fillClass="bg-amber-500"
                    suffix=" cells"
                  />
                  <StatBar
                    label="Validated"
                    value={audio.validatedCells}
                    total={audio.totalCells}
                    fillClass="bg-emerald-500"
                    suffix=" cells"
                  />
                  <StatBar
                    label="Audio"
                    value={audio.audioCells}
                    total={audio.totalCells}
                    fillClass="bg-sky-500"
                    suffix=" cells"
                  />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(translatedPct(audio) * 100)}% translated ·{" "}
                    {Math.round(validatedPct(audio) * 100)}% validated ·{" "}
                    {Math.round(audioPct(audio) * 100)}% with audio · {recordedMinutes(audio)} min recorded
                  </p>
                </div>
              )}

              {/* Per-file rows. Each file's validation bar comes from the
                  files projection (approvedCount / cellCount). Capped to the
                  largest files so the overview stays scannable; the rest are
                  counted, not hidden. */}
              {files.length > 0 && (() => {
                const sorted = [...files].sort((a, b) => b.cellCount - a.cellCount)
                const shown = sorted.slice(0, FILE_ROW_CAP)
                const hidden = sorted.length - shown.length
                return (
                  <div className="mt-4 border-t pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Files {hidden > 0 ? `(top ${FILE_ROW_CAP} of ${sorted.length})` : `(${sorted.length})`}
                      </h2>
                      <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-amber-500" />translated</span>
                        <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-emerald-500" />validated</span>
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {shown.map((f) => {
                        const tPct = f.cellCount > 0 ? Math.round((f.filledCount / f.cellCount) * 100) : 0
                        const vPct = f.cellCount > 0 ? Math.round((f.approvedCount / f.cellCount) * 100) : 0
                        return (
                          <li key={f.fileId} className="flex items-center gap-2 text-sm">
                            <span className="w-40 shrink-0 truncate" title={f.name}>{f.name}</span>
                            <span
                              className="flex-1 space-y-0.5"
                              aria-label={`${tPct}% translated, ${vPct}% validated`}
                            >
                              <span className="block h-1.5 rounded-full bg-muted overflow-hidden shadow-neu-inset">
                                <span className="block h-full rounded-full bg-amber-500" style={{ width: `${tPct}%` }} />
                              </span>
                              <span className="block h-1.5 rounded-full bg-muted overflow-hidden shadow-neu-inset">
                                <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${vPct}%` }} />
                              </span>
                            </span>
                            <span
                              className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                              title="translated / validated / total cells"
                            >
                              {f.filledCount}/{f.approvedCount}/{f.cellCount} · {f.wordCount}w
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                    {hidden > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">+{hidden} more files</p>
                    )}
                  </div>
                )
              })()}

              {/* Deadline */}
              <div className="mt-2 text-sm">
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
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span>
                      Deadline:{" "}
                      {audio?.deadlineAt ? (
                        <span className={dstatus === "overdue" ? "font-medium text-destructive" : "font-medium text-foreground"}>
                          {audio.deadlineAt}{dstatus === "overdue" ? " (overdue)" : dstatus === "soon" ? " (due soon)" : ""}
                        </span>
                      ) : (
                        "none"
                      )}
                    </span>
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

              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => navigate(`/project/${id}`)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                >
                  Open project
                </button>
                {canManage && !isArchived && (
                  <button
                    onClick={handleDownloadBundle}
                    disabled={busy || (project?.files.length ?? 0) === 0}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
                    title={(project?.files.length ?? 0) === 0 ? "No files to export yet" : "Download the finished translation as a .zip"}
                  >
                    Download deliverable
                  </button>
                )}
                {isOwner && !isArchived && (
                  <button
                    onClick={handleArchive}
                    disabled={busy}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
                  >
                    Archive
                  </button>
                )}
                {isOwner && isArchived && (
                  <button
                    onClick={handleRestore}
                    disabled={busy}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
                  >
                    Restore
                  </button>
                )}
              </div>

              {canAssign && !isArchived && activeOrgId != null && (project?.files.length ?? 0) > 0 && (
                <AssignWork
                  projectId={id}
                  files={project?.files ?? []}
                  orgId={activeOrgId}
                  jwt={jwt ?? ""}
                  author={session?.username ?? ""}
                  onAssigned={loadRow}
                />
              )}
            </div>
          )}
        </div>
      }
    />
  )
}
