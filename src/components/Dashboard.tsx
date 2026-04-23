import { useEffect, useState } from "react"
import { useNavigate, Navigate } from "react-router-dom"
import { ChevronRight, Trash2 } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import {
  listProjects,
  listTrashedProjects,
  tombstoneProject,
  restoreProject,
} from "@/lib/store/project-index"
import { ProjectCard } from "./ProjectCard"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import { HeaderAuth } from "@/components/git-import/HeaderAuth"
import { RemoteProjectsSection } from "@/components/git-import/RemoteProjectsSection"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useBrand } from "@/branding/use-brand"

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [trashed, setTrashed] = useState<ProjectRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingTrashId, setPendingTrashId] = useState<string | null>(null)
  const [trashExpanded, setTrashExpanded] = useState(false)
  const [errorToast, setErrorToast] = useState<string | null>(null)
  const { session } = useFrontierSession()
  const navigate = useNavigate()
  const brand = useBrand()

  useEffect(() => {
    Promise.all([listProjects(), listTrashedProjects()])
      .then(([active, binned]) => {
        setProjects(active)
        setTrashed(binned)
      })
      .catch(() => { /* IndexedDB unavailable — render with empty list */ })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!errorToast) return
    const t = setTimeout(() => setErrorToast(null), 4000)
    return () => clearTimeout(t)
  }, [errorToast])

  function upsert(project: ProjectRecord) {
    setProjects(prev => {
      const idx = prev.findIndex(p => p.id === project.id)
      if (idx >= 0) {
        const next = prev.slice()
        next[idx] = project
        return next
      }
      return [...prev, project]
    })
  }

  async function handleTrashConfirm(projectId: string) {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const result = await tombstoneProject(project, {
      jwt: session?.jwt ?? null,
      fallbackUsername: session?.username,
    })
    if (result.remote.kind === "forbidden") {
      setErrorToast(result.remote.message || "Only project owners can move a project to Trash.")
      return
    }
    if (result.remote.kind === "error") {
      setErrorToast(`Couldn't move to Trash: ${result.remote.message}`)
      return
    }
    if (!result.project) return
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
    setTrashed((prev) => [result.project as ProjectRecord, ...prev])
    setTrashExpanded(true)
  }

  async function handleRestore(projectId: string) {
    const project = trashed.find((p) => p.id === projectId)
    if (!project) return
    const result = await restoreProject(project, { jwt: session?.jwt ?? null })
    if (result.remote.kind === "forbidden") {
      setErrorToast(result.remote.message || "Only owners can restore a project.")
      return
    }
    if (result.remote.kind === "error") {
      setErrorToast(`Couldn't restore: ${result.remote.message}`)
      return
    }
    if (!result.project) return
    setTrashed((prev) => prev.filter((p) => p.id !== projectId))
    setProjects((prev) => [...prev, result.project as ProjectRecord])
  }

  function canTrash(p: ProjectRecord): boolean {
    const byRole = p.syncRole?.level != null && p.syncRole.level >= 700
    if (byRole) return true
    // Local-only projects default to local ownership.
    if (!p.origin && !p.syncRole) return true
    return false
  }

  const onboardingComplete = localStorage.getItem("codex:onboardingComplete") === "true"
  if (!loading && !onboardingComplete && projects.length === 0 && trashed.length === 0) {
    return <Navigate to="/onboarding" replace />
  }

  const pendingProject = pendingTrashId
    ? projects.find((p) => p.id === pendingTrashId)
    : null

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <brand.logo.Mark className="h-7 w-7 shrink-0" aria-hidden />
            <h1 className="hidden truncate text-xl font-semibold sm:inline">{brand.app.name}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <HeaderAuth />
            <ProjectCreateDialog onCreated={upsert} />
          </div>
        </div>
      </header>
      <main className="px-6 py-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Your projects</h2>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {session
                ? "No local projects yet. Import one from Frontier below or create a new one."
                : "No projects yet. Create one or log in to import from Frontier."}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onClick={() => navigate(`/project/${p.id}`)}
                  canTrash={canTrash(p)}
                  onTrash={() => setPendingTrashId(p.id)}
                />
              ))}
            </div>
          )}
        </section>

        {session && (
          <RemoteProjectsSection
            session={session}
            localProjects={projects}
            onImported={upsert}
          />
        )}

        {trashed.length > 0 && (
          <section className="mt-10">
            <button
              type="button"
              className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
              onClick={() => setTrashExpanded((v) => !v)}
              aria-expanded={trashExpanded}
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform ${trashExpanded ? "rotate-90" : ""}`}
              />
              <Trash2 className="h-4 w-4" />
              Trash ({trashed.length})
            </button>
            {trashExpanded && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {trashed.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    onClick={() => { /* trashed cards are not clickable */ }}
                    variant="trashed"
                    onRestore={() => handleRestore(p.id)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      <ConfirmActionDialog
        open={pendingTrashId !== null}
        onOpenChange={(v) => { if (!v) setPendingTrashId(null) }}
        title="Move to Trash"
        description={
          pendingProject
            ? `Move "${pendingProject.name}" to Trash? You can restore it later from the Trash section. Other collaborators will lose access until you restore it.`
            : ""
        }
        confirmLabel="Move to Trash"
        checkboxLabel="I understand collaborators lose access until the project is restored."
        onConfirm={() => { if (pendingTrashId) handleTrashConfirm(pendingTrashId) }}
      />

      {errorToast && (
        <div className="fixed bottom-4 right-4 z-[70] rounded border bg-destructive px-3 py-2 text-sm text-destructive-foreground shadow-md">
          {errorToast}
        </div>
      )}
    </div>
  )
}
