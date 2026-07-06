// FRO-235: Banner that surfaces batch AI completion progress.
// Subscribes to the completion batch progress store; renders nothing when idle.
// Mirrors AudioBulkProgressBanner — same visual pattern, different data source.
//
// FRO-361: when a run finishes with one or more sub-batches skipped (after
// retry) the store keeps `progress` around with `finished: true` instead of
// clearing it — so this banner switches to an honest "X of N cells failed"
// summary instead of quietly disappearing as if the whole file completed.

import { X, AlertTriangle } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  useCompletionBatchProgress,
  cancelBatchCompletion,
  dismissBatchCompletionSummary,
} from "@/lib/completion/batch-completion"

export function CompletionBulkProgressBanner() {
  const progress = useCompletionBatchProgress()
  if (!progress) return null

  const { total, done, cancelled, failed, finished } = progress

  // Run is over and some cells failed: show a summary, not a progress bar.
  if (finished && failed > 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm shadow-sm">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>
          {failed} of {total} cells failed
          {done > 0 ? ` — ${done} completed` : ""}.
        </span>
        <div className="flex-1" />
        <AppTooltip content="Dismiss">
          <button
            type="button"
            onClick={dismissBatchCompletionSummary}
            aria-label="Dismiss"
            className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </AppTooltip>
      </div>
    )
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-sm">
      <span className="font-medium">Translating</span>
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
        <AppTooltip content="Stop translating">
          <button
            type="button"
            onClick={cancelBatchCompletion}
            aria-label="Stop translating"
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
