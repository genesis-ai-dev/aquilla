import { useState, useEffect, type ReactNode } from "react"
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
  /** A second paragraph under the description. */
  notice?: string
  confirmLabel: string
  checkboxLabel?: string
  /** Button variant for the confirm action. Defaults to "default". */
  variant?: "default" | "destructive"
  /** Extra controls between the description and the attribution checkbox. */
  extra?: ReactNode
  /** Keeps confirm off even after the checkbox, for example when the chosen options match nothing. */
  confirmDisabled?: boolean
  onConfirm: () => void
}

export function ConfirmActionDialog({
  open, onOpenChange, title, description, notice, confirmLabel,
  checkboxLabel,
  variant = "default",
  extra,
  confirmDisabled = false,
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
          {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        </DialogHeader>
        {extra}
        <label className="flex items-start gap-2 py-2 text-sm">
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => setChecked(value === true)}
            className="mt-0.5"
          />
          <span>{resolvedCheckboxLabel}</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            variant={variant}
            disabled={!checked || confirmDisabled}
            onClick={() => { onConfirm(); onOpenChange(false) }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
