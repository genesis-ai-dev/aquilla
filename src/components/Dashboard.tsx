import { useEffect, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { listProjects } from "@/lib/store/project-index"
import { ProjectCard } from "./ProjectCard"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

interface DashboardProps {
  onSelectProject: (projectId: string) => void
}

export function Dashboard({ onSelectProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectRecord[]>([])

  useEffect(() => {
    listProjects().then(setProjects)
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-xl font-semibold">Codex Translator</h1>
          <ProjectCreateDialog
            onCreated={(project) => setProjects((prev) => [...prev, project])}
          />
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
                onClick={() => onSelectProject(p.id)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
