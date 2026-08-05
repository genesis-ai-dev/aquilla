// Flow B (decision 2026-08-05, simplified 2026-08-06): linking a video while
// the project is in Free timing — the video won't be visible there, so warn
// before linking. Changing the mode stays where the authority for it lives
// (Project Settings, maintainer floor); a combined switch-and-link action was
// deliberately dropped for this release to keep the privilege story simple —
// revisit later if the two-step trip proves annoying.

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface Props {
  open: boolean
  onLinkAnyway(): void
  onCancel(): void
}

export function LinkVideoTimingDialog({ open, onLinkAnyway, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="link-video-timing-dialog">
        <DialogHeader>
          <DialogTitle>This project uses Free timing — the video won't be shown</DialogTitle>
          <DialogDescription>
            A linked video plays on the original recording's timing. This
            project is set to Free timing, where the timeline re-flows to the
            translations' own lengths, so the video will stay hidden until the
            project switches back to Original's timing — a maintainer can
            change that any time in Project Settings, and switching is
            lossless.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button data-testid="link-video-anyway" onClick={onLinkAnyway}>
            Link anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
