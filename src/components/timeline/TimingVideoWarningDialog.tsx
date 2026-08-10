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

interface Props {
  open: boolean
  onConfirm(): void
  onCancel(): void
}

export function TimingVideoWarningDialog({ open, onConfirm, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="timing-video-warning">
        <DialogHeader>
          <DialogTitle>Switch to Free timing and hide the video?</DialogTitle>
          <DialogDescription>
            This file has a linked video, which plays on the original
            recording's timing. Free timing re-flows the timeline to the
            translations' own lengths, so the video will stay hidden until the
            file switches back to Original's timing. Switching is lossless —
            no timing data is changed either way.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm}>Switch to Free timing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
