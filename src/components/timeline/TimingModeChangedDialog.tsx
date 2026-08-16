// The acknowledged heads-up for a REMOTE timing-mode change (Sam,
// 2026-08-06). Purely informational — the change is already applied (shared
// state can't wait for an OK); this explains why the timeline re-flowed and,
// if playback was running, why it stopped.

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AUDIO_TIMING_MODE_LABELS } from "@/lib/parsers/types"
import type { TimingModeAck } from "@/hooks/useTimingModeAck"

interface Props {
  ack: TimingModeAck | null
  onAcknowledge(): void
}

export function TimingModeChangedDialog({ ack, onAcknowledge }: Props) {
  if (!ack) return null
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onAcknowledge() }}>
      <DialogContent data-testid="timing-mode-changed-ack">
        <DialogHeader>
          <DialogTitle>Timing mode changed</DialogTitle>
          <DialogDescription>
            Someone with settings access switched this file from{" "}
            <b>{AUDIO_TIMING_MODE_LABELS[ack.from].name}</b> to{" "}
            <b>{AUDIO_TIMING_MODE_LABELS[ack.to].name}</b>. The Media timeline
            now lays out on the new mode — recordings and timing data are
            untouched.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button data-testid="timing-ack-ok" onClick={onAcknowledge}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
