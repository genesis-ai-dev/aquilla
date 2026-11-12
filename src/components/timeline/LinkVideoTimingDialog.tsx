// Flow B (decision 2026-08-05, simplified 2026-08-06; pre-merge round:
// file-scoped — the timing mode is per-file now, set from the timeline
// toolbar). AQU-2204 (Sam, Oct 26): a file timed to a film always follows its
// source, so linking a film to a file that follows its recordings SWITCHES it.
// This says so before the link is made; clearing the film later gives the file
// its own choice back.

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
  onLinkAnyway(): void
  onCancel(): void
}

export function LinkVideoTimingDialog({ open, onLinkAnyway, onCancel }: Props) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="link-video-timing-dialog">
        <DialogHeader>
          <DialogTitle>{t("workspace.linkVideoTiming.title")}</DialogTitle>
          <DialogDescription>
            {t("workspace.linkVideoTiming.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button data-testid="link-video-anyway" onClick={onLinkAnyway}>
            {t("workspace.linkVideoTiming.linkAnyway")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
