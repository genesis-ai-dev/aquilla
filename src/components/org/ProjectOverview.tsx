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
import { getPortfolio, audioPct, recordedMinutes, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"

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

  const isOwner = (project?.syncRole?.level ?? 0) >= 700
  const canManage = (project?.syncRole?.level ?? 0) >= 600
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
        <div className="p-6">
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
              {audio && audio.totalCells > 0 && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {Math.round(audioPct(audio) * 100)}% of cells have audio · {recordedMinutes(audio)} min recorded
                </p>
              )}

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
            </div>
          )}
        </div>
      }
    />
  )
}
