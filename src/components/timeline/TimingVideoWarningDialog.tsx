// Flow A (decision 2026-08-05; pre-merge round: file-scoped). Switching a
// file to Free timing while it has a linked video hides the video — the video
// plays on the original recording's timing, which Free timing no longer
// follows. Confirm before the mode changes. Lives beside the toolbar control
// now that the mode is file-level (it was a save-intercept in Project
// Settings while the mode lived there); testid and button name are kept from
// the settings dialog so existing browser-pass guards keep matching.

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  open: boolean
  onConfirm(): void
  onCancel(): void
}

export function TimingVideoWarningDialog({ open, onConfirm, onCancel }: Props) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="timing-video-warning">
        <DialogHeader>
          <DialogTitle>{t("workspace.timingVideoWarning.title")}</DialogTitle>
          <DialogDescription>
            {t("workspace.timingVideoWarning.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button onClick={onConfirm}>{t("workspace.timingVideoWarning.confirmButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
