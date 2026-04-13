import { useState } from "react"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"

export default function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  if (activeProjectId) {
    return (
      <ProjectWorkspace
        projectId={activeProjectId}
        onBack={() => setActiveProjectId(null)}
      />
    )
  }

  return <Dashboard onSelectProject={setActiveProjectId} />
}
