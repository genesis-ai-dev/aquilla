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
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

interface Props {
  ack: TimingModeAck | null
  onAcknowledge(): void
}

export function TimingModeChangedDialog({ ack, onAcknowledge }: Props) {
  const t = useT()
  if (!ack) return null
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onAcknowledge() }}>
      <DialogContent data-testid="timing-mode-changed-ack">
        <DialogHeader>
          <DialogTitle>{t("workspace.timingModeChanged.title")}</DialogTitle>
          <DialogDescription>
            <RichMessage
              k="workspace.timingModeChanged.description"
              values={{
                from: <b>{AUDIO_TIMING_MODE_LABELS[ack.from].name}</b>,
                to: <b>{AUDIO_TIMING_MODE_LABELS[ack.to].name}</b>,
              }}
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button data-testid="timing-ack-ok" onClick={onAcknowledge}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
