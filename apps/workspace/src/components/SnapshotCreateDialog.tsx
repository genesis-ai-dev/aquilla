import { useState } from "react"
import { Camera, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { createSnapshot } from "@/lib/store/snapshots"
import type { ProjectSnapshot } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"

interface SnapshotCreateDialogProps {
  projectId: string
  onCreated: (snapshot: ProjectSnapshot) => void
}

export function SnapshotCreateDialog({ projectId, onCreated }: SnapshotCreateDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    try {
      const snap = await createSnapshot(projectId, name.trim(), description.trim() || undefined, false)
      posthog.capture("snapshot created", {
        project_id: projectId,
        snapshot_id: snap.id,
        snapshot_name: snap.name,
      })
      onCreated(snap)
      setName("")
      setDescription("")
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create snapshot")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Camera className="mr-1 h-3.5 w-3.5" />
            Create snapshot
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Project Snapshot</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="snap-name">Name</Label>
            <Input
              id="snap-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="First draft complete"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="snap-desc">Description (optional)</Label>
            <Input
              id="snap-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ready for review"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || creating} className="flex-1">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
