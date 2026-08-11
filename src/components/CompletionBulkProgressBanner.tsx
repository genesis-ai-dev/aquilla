// AQU-235: Banner that surfaces batch AI completion progress.
// Subscribes to the completion batch progress store; renders nothing when idle.
// Mirrors AudioBulkProgressBanner — same visual pattern, different data source.
//
// AQU-361: when a run finishes with one or more sub-batches skipped (after
// retry) the store keeps `progress` around with `finished: true` instead of
// clearing it — so this banner switches to an honest "X of N cells failed"
// summary instead of quietly disappearing as if the whole file completed.

import { X, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  useCompletionBatchProgress,
  cancelBatchCompletion,
  dismissBatchCompletionSummary,
} from "@/lib/completion/batch-completion"

export function CompletionBulkProgressBanner() {
  // `useT` before the idle early-return: hooks cannot sit after a conditional.
  const t = useT()
  const progress = useCompletionBatchProgress()
  if (!progress) return null

  const { total, done, cancelled, failed, finished } = progress

  // Run is over and some cells failed: show a summary, not a progress bar.
  if (finished && failed > 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm shadow-sm">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>
          {done > 0
            ? t("editor.completion.failedPartial", { failed, total, done })
            : t("editor.completion.failed", { failed, total })}
        </span>
        <div className="flex-1" />
        <AppTooltip content={t("common.dismiss")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={dismissBatchCompletionSummary}
            aria-label={t("common.dismiss")}
            className="ml-1 text-muted-foreground"
          >
            <X />
          </Button>
        </AppTooltip>
      </div>
    )
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
      <span className="font-medium">{t("editor.completion.translating")}</span>
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
        <AppTooltip content={t("editor.completion.stop")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={cancelBatchCompletion}
            aria-label={t("editor.completion.stop")}
            className="ml-1 text-muted-foreground"
          >
            <X />
          </Button>
        </AppTooltip>
      )}
      {cancelled && (
        <span className="text-muted-foreground">{t("editor.completion.cancelling")}</span>
      )}
    </div>
  )
}
