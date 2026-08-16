// Flow B (decision 2026-08-05, simplified 2026-08-06; pre-merge round:
// file-scoped — the timing mode is per-file now, set from the timeline
// toolbar). Linking a video while the file is in Free timing — the video
// won't be visible there, so warn before linking. A combined
// switch-and-link action was deliberately dropped to keep the privilege
// story simple — revisit later if the two-step trip proves annoying.

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
