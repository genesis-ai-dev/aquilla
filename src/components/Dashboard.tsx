import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import { listProjects } from "@/lib/store/project-index"
import { ProjectCard } from "./ProjectCard"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import { GitImportDialog } from "@/components/git-import/GitImportDialog"
import { HeaderAuth } from "@/components/git-import/HeaderAuth"

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [gitImportOpen, setGitImportOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    listProjects().then(setProjects)
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-xl font-semibold">Codex Translator</h1>
          <div className="flex items-center gap-2">
            <HeaderAuth onImportClick={() => setGitImportOpen(true)} />
            <ProjectCreateDialog
              onCreated={(project) => setProjects((prev) => [...prev, project])}
            />
          </div>
        </div>
      </header>
      <main className="px-6 py-6">
        {projects.length === 0 ? (
          <p className="text-muted-foreground">
            No projects yet. Create one to get started.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onClick={() => navigate(`/project/${p.id}`)}
              />
            ))}
          </div>
        )}
      </main>
      <GitImportDialog
        open={gitImportOpen}
        onOpenChange={setGitImportOpen}
        onImported={(projectId) => {
          setGitImportOpen(false)
          navigate(`/project/${projectId}`)
        }}
      />
    </div>
  )
}
