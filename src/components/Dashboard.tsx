import { useEffect, useState } from "react"
import { useNavigate, Navigate } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import { listProjects } from "@/lib/store/project-index"
import { ProjectCard } from "./ProjectCard"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import { HeaderAuth } from "@/components/git-import/HeaderAuth"
import { RemoteProjectsSection } from "@/components/git-import/RemoteProjectsSection"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useBrand } from "@/branding/use-brand"

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [loading, setLoading] = useState(true)
  const { session } = useFrontierSession()
  const navigate = useNavigate()
  const brand = useBrand()

  useEffect(() => {
    listProjects()
      .then((p) => { setProjects(p) })
      .catch(() => { /* IndexedDB unavailable — render with empty list */ })
      .finally(() => setLoading(false))
  }, [])

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

  const onboardingComplete = localStorage.getItem("codex:onboardingComplete") === "true"
  if (!loading && !onboardingComplete && projects.length === 0) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <brand.logo.Mark className="h-7 w-7 shrink-0" aria-hidden />
            <h1 className="text-xl font-semibold">{brand.app.name}</h1>
          </div>
          <div className="flex items-center gap-2">
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
                <ProjectCard key={p.id} project={p} onClick={() => navigate(`/project/${p.id}`)} />
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
      </main>
    </div>
  )
}
