// FRO-278 — GenerateOverwriteDialog
// ---------------------------------------------------------------------------
// Lightweight confirm dialog shown when the user clicks AI Generate on a cell
// that already contains human-authored text. The copy is escalated when the
// cell has been validated so the expert understands validation will be cleared.
//
// Cancel semantics: nothing is committed, no completion is triggered. The user
// returns to the cell in its current state. We chose "never start" over
// "start-then-discard" because an in-progress stream would occupy the cell's
// "generating" state and confuse the UX on cancel.
//
// AQU-646: extracted from EditorTable so the media-lens detail pane can show
// the byte-identical confirm without importing the whole editor module.

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"

interface GenerateOverwriteDialogProps {
  open: boolean
  /** True when cell.status === "validated" — escalates the dialog copy. */
  isValidated: boolean
  /**
   * Confirm replacing the translation. `dontAskAgain` is true when the user
   * ticked "Don't ask again" (AQU-591) — the caller persists the opt-out so
   * future non-validated replacements skip this dialog.
   */
  onConfirm: (dontAskAgain: boolean) => void
  onCancel: () => void
}

export function GenerateOverwriteDialog({
  open,
  isValidated,
  onConfirm,
  onCancel,
}: GenerateOverwriteDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // Reset the checkbox each time the dialog opens so a prior tick never leaks
  // into a later confirmation.
  useEffect(() => {
    if (open) setDontAskAgain(false)
  }, [open])

  const title = isValidated
    ? "Replace validated translation?"
    : "Replace existing translation?"

  const description = isValidated
    ? "This cell is validated — replacing it clears the validation. The current text is preserved in cell history and can be recovered."
    : "Replace the existing translation? The current text is preserved in cell history and can be recovered."

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent aria-labelledby="gen-overwrite-title" aria-describedby="gen-overwrite-desc">
        <DialogHeader>
          <DialogTitle id="gen-overwrite-title">{title}</DialogTitle>
          <DialogDescription id="gen-overwrite-desc">{description}</DialogDescription>
        </DialogHeader>
        {/* AQU-591: opting out only skips the confirm for non-validated cells —
            replacing a validated translation always confirms, so no opt-out. */}
        {!isValidated && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(c) => setDontAskAgain(c === true)}
            />
            Don't ask again when replacing a translation
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(dontAskAgain)}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
