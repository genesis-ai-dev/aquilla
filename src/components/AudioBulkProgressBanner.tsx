// Banner that surfaces batch transcribe-all / synth-all progress.
// Subscribes to the batch-audio progress store; renders nothing when idle.

import { X } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  useBatchProgress,
  cancelBatchTranscribe,
  cancelBatchSynth,
} from "@/lib/audio/batch-audio"

export function AudioBulkProgressBanner() {
  const progress = useBatchProgress()
  if (!progress) return null

  const { kind, total, done, cancelled } = progress
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const label = kind === "transcribe" ? "Transcribing" : "Synthesizing"
  const handleCancel = () => {
    if (kind === "transcribe") cancelBatchTranscribe()
    else cancelBatchSynth()
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-sm">
      <span className="font-medium">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
      {!cancelled && (
        <AppTooltip content="Cancel batch">
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Cancel batch"
            className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </AppTooltip>
      )}
      {cancelled && (
        <span className="text-muted-foreground">cancelling…</span>
      )}
    </div>
  )
}
