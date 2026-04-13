import { useParams, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"

export function ProjectSettings() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          ← Back to Editor
        </Button>
        <h2 className="font-semibold">Project Settings</h2>
      </header>
      <main className="mx-auto max-w-2xl p-6">
        <p className="text-muted-foreground">Settings form coming soon.</p>
      </main>
    </div>
  )
}
