// SnapshotRestoreDialog — typed-confirmation restore dialog (FRO-176).
//
// Spec: restore is irreversible-by-default (changes many cells) so the
// confirmation is TYPED — user must type the snapshot name (matching
// 09-design-and-ux.md confirmation tiers for destructive multi-cell actions).
//
// Also shows a brief summary of what will change (from the restoreResult
// returned after the actual call).

import { useState, useEffect } from "react"
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
import type { Snapshot, RestoreResult } from "@/hooks/useSnapshots"

interface SnapshotRestoreDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshot: Snapshot | null
  onRestore: (snapshotId: string) => Promise<RestoreResult>
  onRestored?: (result: RestoreResult) => void
}

export function SnapshotRestoreDialog({
  open,
  onOpenChange,
  snapshot,
  onRestore,
  onRestored,
}: SnapshotRestoreDialogProps) {
  const [confirmText, setConfirmText] = useState("")
  const [isRestoring, setIsRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setConfirmText("")
      setError(null)
      setIsRestoring(false)
    }
  }, [open])

  if (!snapshot) return null

  const confirmed = confirmText.trim() === snapshot.name.trim()

  async function handleRestore() {
    if (!snapshot || !confirmed) return
    setIsRestoring(true)
    setError(null)
    try {
      const result = await onRestore(snapshot.id)
      onRestored?.(result)
      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Restore failed: ${msg}`)
      setIsRestoring(false)
    }
  }

  const createdDate = new Date(snapshot.snapshotTs).toLocaleString()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore snapshot</DialogTitle>
          <DialogDescription>
            This will overwrite all cells with their values from{" "}
            <strong>{snapshot.name}</strong> (taken {createdDate}). Current
            values are preserved in cell history. This action cannot be undone
            without another restore.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            Type <span className="font-mono font-semibold">{snapshot.name}</span> to
            confirm:
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={snapshot.name}
            autoFocus
            disabled={isRestoring}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isRestoring}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!confirmed || isRestoring}
            onClick={() => void handleRestore()}
          >
            {isRestoring ? "Restoring…" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
