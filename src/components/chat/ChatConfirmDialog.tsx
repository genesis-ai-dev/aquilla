/**
 * ChatConfirmDialog.tsx — chat UX improvements
 *
 * Lightweight confirm dialog for chat actions (clear conversation,
 * insert-into-cell overwrite). Mirrors EditorTable's GenerateOverwriteDialog
 * pattern: Dialog + Cancel/Confirm footer, no checkbox gate.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface ChatConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  variant?: "default" | "destructive"
  onConfirm: () => void
  onCancel: () => void
}

export function ChatConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  variant = "default",
  onConfirm,
  onCancel,
}: ChatConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={variant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
