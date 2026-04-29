import { useState } from "react"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"

interface ProjectCreateDialogProps {
  onCreated: (project: ProjectRecord) => void
}

export function ProjectCreateDialog({ onCreated }: ProjectCreateDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()) return

    const project: ProjectRecord = {
      id: uuid(),
      name: name.trim(),
      sourceLanguage: sourceLanguage.trim(),
      targetLanguage: targetLanguage.trim(),
      createdAt: new Date().toISOString(),
      files: [],
      members: [{ userId: "local", role: "owner" }],
    }

    await createProject(project)
    posthog.capture("project created", {
      project_id: project.id,
      source_language: project.sourceLanguage,
      target_language: project.targetLanguage,
    })
    onCreated(project)
    setName("")
    setSourceLanguage("")
    setTargetLanguage("")
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>+ New Project</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Translation Project"
            />
          </div>
          <div>
            <Label htmlFor="source">Source Language</Label>
            <Input
              id="source"
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              placeholder="e.g. en, es-419, ar"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              BCP-47 tag of the language you're translating <em>from</em>.
            </p>
          </div>
          <div>
            <Label htmlFor="target">Target Language</Label>
            <Input
              id="target"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              placeholder="e.g. fr, sw, zh-Hant"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              BCP-47 tag of the language you're translating <em>into</em>.
            </p>
          </div>
          <Button type="submit" className="w-full">
            Create Project
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
