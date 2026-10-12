import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"

interface ConfirmActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  checkboxLabel?: string
  /**
   * False when the description already says the action can do nothing here.
   * The dialog then shows the description with a single Close button: no
   * acknowledgement to tick and no confirm that would only fail. Defaults to
   * true.
   */
  canConfirm?: boolean
  /** Button variant for the confirm action. Defaults to "default". */
  variant?: "default" | "destructive"
  onConfirm: () => void
}

export function ConfirmActionDialog({
  open, onOpenChange, title, description, confirmLabel,
  checkboxLabel,
  canConfirm = true,
  variant = "default",
  onConfirm,
}: ConfirmActionDialogProps) {
  const t = useT()
  const [checked, setChecked] = useState(false)
  useEffect(() => { if (!open) setChecked(false) }, [open])
  const resolvedCheckboxLabel = checkboxLabel ?? t("dialog.confirmCheckboxDefault")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {canConfirm && (
          <label className="flex items-start gap-2 py-2 text-sm">
            <Checkbox
              checked={checked}
              onCheckedChange={(value) => setChecked(value === true)}
              className="mt-0.5"
            />
            <span>{resolvedCheckboxLabel}</span>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {canConfirm ? t("common.cancel") : t("common.close")}
          </Button>
          {canConfirm && (
            <Button
              variant={variant}
              disabled={!checked}
              onClick={() => { onConfirm(); onOpenChange(false) }}
            >
              {confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
