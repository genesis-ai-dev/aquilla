import { useEffect, useMemo, useState } from "react"
import { useNavigate, Navigate } from "react-router-dom"
import {
  ChevronRight, Cloud, Settings as SettingsIcon, Trash2, Users,
} from "lucide-react"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { OverflowMenu } from "@/components/OverflowMenu"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useBrand } from "@/branding/use-brand"
import {
  fetchAccessibleProjects,
  minimalProjectRecord,
  type CloudProjectSummary,
} from "@/lib/sync/cloud-projects"
import { filterCloudOnly } from "@/lib/projects/dedupe-cloud"
import posthog from "@/lib/posthog"

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [trashed, setTrashed] = useState<ProjectRecord[]>([])
  const [cloudProjects, setCloudProjects] = useState<CloudProjectSummary[]>([])
  const [cloudProjectsLoaded, setCloudProjectsLoaded] = useState(false)
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

  // Cloud-side discovery: list every project the user has access to on the
  // server. Dedup against IDB happens at render time (see cloudOnly).
  // The cloudProjectsLoaded flag gates the onboarding redirect — without it
  // we'd briefly redirect signed-in users with cloud-only projects to the
  // wizard before the cloud list arrives.
  useEffect(() => {
    if (!session?.jwt) {
      setCloudProjects([])
      setCloudProjectsLoaded(true)
      return
    }
    let cancelled = false
    setCloudProjectsLoaded(false)
    fetchAccessibleProjects(session.jwt)
      .then((list) => {
        if (!cancelled) setCloudProjects(list)
      })
      .finally(() => {
        if (!cancelled) setCloudProjectsLoaded(true)
      })
    return () => { cancelled = true }
  }, [session?.jwt])

  // Projects the user can access on the server but haven't opened on this
  // device yet. Dedup against local + trashed by id AND by gitlabProjectId
  // — GitLab-imported projects have a different local IDB id than the
  // canonical server id but share a GitLab id, so id-only dedup would show
  // both cards.
  const cloudOnly = useMemo(
    () => filterCloudOnly(cloudProjects, projects, trashed),
    [cloudProjects, projects, trashed]
  )

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
    posthog.capture("project trashed", { project_id: projectId, project_name: project.name })
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
    posthog.capture("project restored", { project_id: projectId, project_name: project.name })
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

  // Onboarding gate: only steer first-time users into the wizard. A signed-in
  // user with cloud projects on another device should land on the dashboard
  // and see those projects, not the "create your first project" flow. Wait
  // for cloudProjectsLoaded so we don't flash-redirect before the list arrives.
  const onboardingComplete = localStorage.getItem("codex:onboardingComplete") === "true"
  const hasAnyProject =
    projects.length > 0 || trashed.length > 0 || cloudProjects.length > 0
  const cloudReady = !session?.jwt || cloudProjectsLoaded
  if (!loading && cloudReady && !onboardingComplete && !hasAnyProject) {
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
            {/* Hard <a>: /homepage is the separate marketing entry point. */}
            <a
              href="/homepage"
              aria-label={`${brand.app.name} — homepage`}
              className="-m-1 shrink-0 rounded-md p-1 hover:bg-accent/60"
            >
              <brand.logo.Mark className="h-7 w-7" aria-hidden />
            </a>
            <h1 className="hidden truncate text-xl font-semibold sm:inline">{brand.app.name}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <OverflowMenu
              items={[
                { id: "members", label: "Members", icon: Users, onClick: () => navigate("/members") },
                { id: "settings", label: "Settings", icon: SettingsIcon, onClick: () => navigate("/settings") },
              ]}
            />
            <ProjectCreateDialog onCreated={upsert} />
            <AccountSwitcher variant="header" />
          </div>
        </div>
      </header>
      <main className="px-6 py-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Your projects</h2>
          {loading && projects.length === 0 ? (
            <ProjectCardGridSkeleton count={3} />
          ) : projects.length === 0 ? (
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

        {cloudOnly.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Cloud className="h-4 w-4" />
              Your cloud projects
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Projects you can access that aren't on this device yet. Clicking one downloads its state.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cloudOnly.map((cp) => (
                <ProjectCard
                  key={cp.id}
                  project={minimalProjectRecord(cp)}
                  onClick={() => navigate(`/project/${cp.id}`)}
                />
              ))}
            </div>
          </section>
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
        <div className="fixed bottom-4 right-4 z-60 rounded border bg-destructive px-3 py-2 text-sm text-destructive-foreground shadow-md">
          {errorToast}
        </div>
      )}
    </div>
  )
}

/** Placeholder cards rendered while IDB is loading — prevents the split-
 *  second "No local projects yet…" flash before listProjects resolves. */
function ProjectCardGridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} aria-hidden>
          <CardHeader className="pb-2">
            <Skeleton className="h-6 w-2/3" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
