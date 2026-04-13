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
              placeholder="en"
            />
          </div>
          <div>
            <Label htmlFor="target">Target Language</Label>
            <Input
              id="target"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              placeholder="fr"
            />
          </div>
          <Button type="submit" className="w-full">
            Create Project
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
