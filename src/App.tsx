import { useState } from "react"
import { Dashboard } from "@/components/Dashboard"

export default function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  if (activeProjectId) {
    return (
      <div className="p-8">
        <button onClick={() => setActiveProjectId(null)}>← Back</button>
        <p>Project: {activeProjectId}</p>
        <p className="text-muted-foreground">Workspace coming in next task.</p>
      </div>
    )
  }

  return <Dashboard onSelectProject={setActiveProjectId} />
}
