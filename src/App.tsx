import { useState } from "react"

export default function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  if (activeProjectId) {
    return (
      <div>
        <button onClick={() => setActiveProjectId(null)}>Back</button>
        <p>Project: {activeProjectId}</p>
      </div>
    )
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Codex Translator</h1>
      <p className="text-muted-foreground">No projects yet.</p>
    </div>
  )
}
