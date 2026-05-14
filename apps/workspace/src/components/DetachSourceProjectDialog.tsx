// Phase 5 / AD-9. Confirmation modal for `POST /:projectId/detach-source`.
//
// Detach is destructive in the "you can't undo this in one click" sense:
// the upstream link is broken, the upstream's current source cells are
// snapshotted into this project as a burst of `source.cell.commit`
// events, and subsequent upstream edits no longer flow. We surface the
// returned snapshot stats so the actor sees what landed.

import { useState } from "react"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { DetachResult } from "@/lib/sync/source-linking-read-types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Display name of the upstream — falls back to "the upstream project" when
   *  unknown. Purely cosmetic. */
  sourceProjectName?: string
  /** Disables the submit button while a parent mutation is in flight. */
  isMutating?: boolean
  /** Surface from `useProjectSource.error`. */
  error?: string | null
  /** Called when the user confirms. Returns the snapshot stats on
   *  success (or null when the parent's mutation failed). */
  onConfirm: () => Promise<DetachResult | null>
}

export function DetachSourceProjectDialog({
  open,
  onOpenChange,
  sourceProjectName,
  isMutating,
  error,
  onConfirm,
}: Props) {
  const [result, setResult] = useState<DetachResult | null>(null)

  async function handleConfirm() {
    setResult(null)
    const out = await onConfirm()
    if (out) setResult(out)
    // Stay open on success so the user reads the snapshot count; they
    // dismiss via the explicit Close button below.
  }

  // Reset when the dialog reopens.
  function handleOpenChange(next: boolean) {
    if (!next) setResult(null)
    onOpenChange(next)
  }

  const sourceName = sourceProjectName || "the upstream project"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Detach from source project?
          </DialogTitle>
          <DialogDescription>
            Detaching from <strong>{sourceName}</strong> will snapshot its
            current source cells into this project. You'll diverge from upstream
            from now on — subsequent edits to {sourceName} will <em>not</em>
            flow into this project.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">Detached.</div>
              <p className="text-xs text-muted-foreground">
                Snapshotted {result.snapshottedCellCount.toLocaleString()} source
                cell{result.snapshottedCellCount === 1 ? "" : "s"} from{" "}
                {sourceName}. This project is now self-contained.
              </p>
            </div>
          </div>
        ) : null}

        {error && !result && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {result ? (
            <DialogClose render={<Button />}>Close</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button
                variant="destructive"
                onClick={handleConfirm}
                disabled={Boolean(isMutating)}
              >
                {isMutating ? "Detaching…" : "Detach"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
