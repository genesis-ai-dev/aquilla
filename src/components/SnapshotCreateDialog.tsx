// SnapshotCreateDialog — named snapshot creation dialog (FRO-176).
//
// Opens as a modal; caller provides onCreated callback and a createFn
// (from useSnapshots) so this component stays testable without a live
// sync-worker connection.
//
// Requires maintainer+ role (the caller should gate the open trigger).

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Snapshot } from "@/hooks/useSnapshots"

interface SnapshotCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Create function from useSnapshots; should throw SnapshotApiError on failure. */
  onCreate: (name: string, description?: string) => Promise<Snapshot>
  onCreated?: (snapshot: Snapshot) => void
}

export function SnapshotCreateDialog({
  open,
  onOpenChange,
  onCreate,
  onCreated,
}: SnapshotCreateDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setName("")
    setDescription("")
    setError(null)
    setIsSubmitting(false)
  }

  function handleOpenChange(val: boolean) {
    if (!val) reset()
    onOpenChange(val)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError("Snapshot name is required.")
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      const snap = await onCreate(trimmedName, description.trim() || undefined)
      onCreated?.(snap)
      handleOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Failed to create snapshot: ${msg}`)
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create snapshot</DialogTitle>
          <DialogDescription>
            Save a named point-in-time snapshot of this project. You can restore
            to this state later from the Snapshots page.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e: React.FormEvent<HTMLFormElement>) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="snapshot-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="snapshot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Before harmonization pass"
              autoFocus
              maxLength={200}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="snapshot-description" className="text-sm font-medium text-muted-foreground">
              Description <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id="snapshot-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's happening at this point in the project?"
              rows={3}
              disabled={isSubmitting}
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? "Creating…" : "Create snapshot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
