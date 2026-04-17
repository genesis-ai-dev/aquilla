import { useState } from "react"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ProjectStep({
  displayName,
  onCreated,
  onBack,
}: {
  displayName: string
  onCreated: (p: ProjectRecord) => void
  onBack: () => void
}) {
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [busy, setBusy] = useState(false)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()) return
    setBusy(true)
    try {
      const project: ProjectRecord = {
        id: uuid(),
        name: name.trim(),
        sourceLanguage: sourceLanguage.trim(),
        targetLanguage: targetLanguage.trim(),
        createdAt: new Date().toISOString(),
        files: [],
        members: [{ userId: "local", role: "owner" }],
        username: displayName || "Anonymous",
      }
      await createProject(project)
      onCreated(project)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">Create your first project</h2>
        <p className="text-sm text-muted-foreground">
          You can import files and invite collaborators after setup.
        </p>
      </div>
      <form onSubmit={handleCreate} className="space-y-4">
        <div>
          <Label htmlFor="proj-name">Project name</Label>
          <Input
            id="proj-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Translation Project"
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="src-lang">Source language</Label>
          <Input
            id="src-lang"
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value)}
            placeholder="English"
          />
        </div>
        <div>
          <Label htmlFor="tgt-lang">Target language</Label>
          <Input
            id="tgt-lang"
            value={targetLanguage}
            onChange={(e) => setTargetLanguage(e.target.value)}
            placeholder="French"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={busy || !name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()}
        >
          {busy ? "Creating…" : "Create Project"}
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
