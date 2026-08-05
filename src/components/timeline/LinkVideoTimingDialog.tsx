// Flow B (decision 2026-08-05): linking a video while the project is in Free
// timing — the video won't be visible there, so prompt to switch back to
// Original's timing. Declining is allowed (the video links but stays hidden;
// the timeline's own note explains in place). Extracted from ProjectWorkspace
// so the three-way choice is testable on its own.

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
  /** Whether this user may change the timing mode (maintainer floor). Below
   *  it the switch action is replaced by a hint. */
  canSwitch: boolean
  onSwitchToOriginal(): void
  onLinkAnyway(): void
  onCancel(): void
}

export function LinkVideoTimingDialog({ open, canSwitch, onSwitchToOriginal, onLinkAnyway, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="link-video-timing-dialog">
        <DialogHeader>
          <DialogTitle>This project uses Free timing — the video won't be shown</DialogTitle>
          <DialogDescription>
            A linked video plays on the original recording's timing. This
            project is set to Free timing, where the timeline re-flows to the
            translations' own lengths, so the video will stay hidden until the
            project switches back to Original's timing. Switching is lossless
            and can be changed any time in Project Settings.
          </DialogDescription>
        </DialogHeader>
        {!canSwitch && (
          <p className="text-xs text-muted-foreground">
            Only a maintainer can change the timing mode.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="outline" data-testid="link-video-anyway" onClick={onLinkAnyway}>
            Link anyway
          </Button>
          {canSwitch && (
            <Button data-testid="link-video-switch" onClick={onSwitchToOriginal}>
              Switch to Original timing and link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
