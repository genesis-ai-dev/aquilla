// Persistent toast that surfaces bulk transcribe / bulk synth progress so
// the user can keep working in other cells while a many-step run executes.
// Lives at the App root next to AiModelDownloadChip.

import { CheckCircle2, Loader2, X } from "lucide-react"
import { useState } from "react"
import { cancelBulkOperation, useBulkState } from "@/lib/audio/bulk-audio"
import { cn } from "@/lib/utils"

const LABELS: Record<string, { running: string; done: string }> = {
  "transcribe-all": { running: "Transcribing audio", done: "Transcription complete" },
  "synth-all": { running: "Generating AI voice", done: "AI voice generated" },
}

export function AudioBulkProgressBanner() {
  const state = useBulkState()
  const [hidden, setHidden] = useState(false)

  if (hidden && state.kind === "idle") return null
  if (state.kind === "idle") return null

  const labels = LABELS[state.progress.kind]
  const total = state.progress.total
  const done = state.progress.completed + state.progress.failed
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const isRunning = state.kind === "running"

  return (
    <div
      className={cn(
        // Anchored bottom-right but above the workspace footer.
        "fixed bottom-16 right-4 z-30 w-80 rounded-lg border bg-popover p-3 text-xs shadow-lg",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        )}
        <span className="font-medium">
          {isRunning ? labels.running : labels.done}
        </span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        <button
          type="button"
          onClick={() => { setHidden(true); if (isRunning) cancelBulkOperation() }}
          aria-label={isRunning ? "Cancel" : "Dismiss"}
          title={isRunning ? "Cancel remaining cells" : "Dismiss"}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      {isRunning && state.progress.currentCellLabel && (
        <p className="mt-1.5 truncate text-[10px] text-muted-foreground">
          Working on <span className="font-medium text-foreground">{state.progress.currentCellLabel}</span>
        </p>
      )}
      {!isRunning && state.progress.failed > 0 && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          {state.progress.failed} cell{state.progress.failed === 1 ? "" : "s"} failed — check the per-cell badges.
        </p>
      )}
    </div>
  )
}
