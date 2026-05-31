import { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import { archiveProjectRemote, unarchiveProjectRemote } from "@/lib/sync/archive"
import { getPortfolio, audioPct, recordedMinutes, type PortfolioProject } from "@/lib/frontier/portfolio"

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

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    getPortfolio(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setAudio(list.find((p) => p.id === id) ?? null) })
      .catch(() => { if (!cancelled) setAudio(null) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId, id])

  const isOwner = (project?.syncRole?.level ?? 0) >= 700
  const isArchived = Boolean(project?.deletedAt)

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
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => navigate(`/project/${id}`)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                >
                  Open project
                </button>
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
