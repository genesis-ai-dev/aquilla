// AQU-235: Banner that surfaces batch AI completion progress.
// Subscribes to the completion batch progress store; renders nothing when idle.
// Mirrors AudioBulkProgressBanner — same visual pattern, different data source.
//
// AQU-361: when a run finishes with one or more sub-batches skipped (after
// retry) the store keeps `progress` around with `finished: true` instead of
// clearing it — so this banner switches to an honest "X of N cells failed"
// summary instead of quietly disappearing as if the whole file completed.
//
// AQU-2654: long work is honest about itself (docs/decisions 0013). While a
// run is live the banner says which file, how many cells and for how long; a
// run with no progress for STALL_CEILING_MS offers Retry / Stop instead of a
// bar that just sits there; and EVERY way a run can end — done, stopped,
// failed, interrupted by a reload — leaves a terminal state with the remainder
// one click from being drafted. The same component renders inline in the
// editor and floating everywhere else (CompletionBatchStatusHost).

import { useEffect, useState } from "react"
import { Link, useInRouterContext } from "react-router-dom"
import { X, AlertTriangle, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  useCompletionBatchProgress,
  useInlineBatchCompletionBannerMounted,
  registerInlineBatchCompletionBanner,
  restoreInterruptedBatchCompletion,
  cancelBatchCompletion,
  dismissBatchCompletionSummary,
  resumeBatchCompletion,
  getCompletionBatchProgress,
  STALL_CEILING_MS,
  type CompletionBatchProgress,
} from "@/lib/completion/batch-completion"

/** Failed cells named in the summary before it says "and N more". */
const FAILED_CELLS_SHOWN = 5
/** A run this short was watched from start to finish; its "done" line clears
 *  itself. A longer one is exactly the run the user walked away from, so its
 *  completion stays until they have seen it. */
const SHORT_RUN_MS = 60_000
const SHORT_RUN_DONE_LINGER_MS = 6_000

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const ss = String(seconds).padStart(2, "0")
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
    : `${minutes}:${ss}`
}

/** The clock ticks in this leaf only — a per-second state change must not
 *  re-render the banner's parent, let alone the workspace. */
function RunningClock({ startedAt }: { startedAt: number }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const time = formatElapsed(now - startedAt)
  return (
    <span
      className="tabular-nums text-muted-foreground"
      aria-label={t("editor.completion.elapsed", { time })}
      title={t("editor.completion.elapsed", { time })}
      data-testid="completion-batch-elapsed"
    >
      {time}
    </span>
  )
}

function DismissButton() {
  const t = useT()
  return (
    <AppTooltip content={t("common.dismiss")}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={dismissBatchCompletionSummary}
        aria-label={t("common.dismiss")}
        className="ms-1 shrink-0 text-muted-foreground"
      >
        <X />
      </Button>
    </AppTooltip>
  )
}

function OpenFileLink({ progress }: { progress: CompletionBatchProgress }) {
  const t = useT()
  const inRouter = useInRouterContext()
  const { projectId, fileId } = progress.scope
  if (!inRouter || !projectId || !fileId) return null
  return (
    <Link
      className="shrink-0 underline underline-offset-2"
      to={`/project/${projectId}/editor/file/${fileId}`}
    >
      {t("editor.completion.openFile")}
    </Link>
  )
}

/** Retry / resume the remainder. When the cells are not loaded (another file
 *  or another page is open) it says so and links to the file, rather than
 *  doing nothing. */
function RetryRemainder({
  progress,
  labelKey,
}: {
  progress: CompletionBatchProgress
  labelKey: "editor.completion.retryRemaining" | "editor.completion.resumeRemaining"
}) {
  const t = useT()
  const [needsFile, setNeedsFile] = useState(false)
  const count = progress.remainingCellIds.length
  if (count === 0) return null
  return (
    <>
      {needsFile && (
        <span className="text-muted-foreground">
          {t("editor.completion.openFileToRetry", {
            file: progress.scope.fileName ?? "…",
          })}{" "}
          <OpenFileLink progress={progress} />
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => setNeedsFile(!resumeBatchCompletion())}
      >
        {t(labelKey, { count })}
      </Button>
    </>
  )
}

function FailedCellsLines({ progress }: { progress: CompletionBatchProgress }) {
  const t = useT()
  const { failedCells, failed, runError } = progress
  const named = failedCells.slice(0, FAILED_CELLS_SHOWN).map((cell) => cell.label ?? cell.cellId)
  const more = failed - named.length
  const reason = failedCells[0]?.reason
  if (named.length === 0 && !runError) return null
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-testid="completion-batch-failed-cells">
      {runError && <p>{t("editor.completion.runFailed", { reason: runError })}</p>}
      {named.length > 0 && (
        <p>
          {more > 0
            ? t("editor.completion.failedCellsMore", { cells: named.join(", "), count: more })
            : t("editor.completion.failedCells", { cells: named.join(", ") })}
        </p>
      )}
      {reason && <p>{t("editor.completion.failedReason", { reason })}</p>}
    </div>
  )
}

function useAutoDismissShortDoneRun(progress: CompletionBatchProgress | null) {
  const runId = progress?.runId
  const shortDone =
    progress?.outcome === "done" &&
    progress.endedAt !== null &&
    progress.endedAt - progress.startedAt < SHORT_RUN_MS
  useEffect(() => {
    if (!shortDone) return
    const timer = setTimeout(() => {
      const current = getCompletionBatchProgress()
      if (current && current.runId === runId && current.outcome === "done") dismissBatchCompletionSummary()
    }, SHORT_RUN_DONE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [shortDone, runId])
}

export function CompletionBulkProgressBanner({
  variant = "inline",
}: {
  /** `inline` in the editor; `floating` when hosted app-wide. */
  variant?: "inline" | "floating"
}) {
  // `useT` before the idle early-return: hooks cannot sit after a conditional.
  const t = useT()
  const progress = useCompletionBatchProgress()
  useEffect(() => {
    if (variant !== "inline") return
    return registerInlineBatchCompletionBanner()
  }, [variant])
  useAutoDismissShortDoneRun(progress)
  if (!progress) return null

  const { total, done, cancelled, failed, finished, outcome, scope, stalled, unavailable } = progress
  const fileName = scope.fileName

  // AQU-1377: the batch was refused before it started because the AI service is
  // unreachable. Previously completeBatch returned silently, so the click did
  // nothing visible at all — this is the explicit message instead.
  if (unavailable) {
    return (
      <div
        role="alert"
        data-testid="completion-batch-status"
        data-outcome="unavailable"
        className="flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm shadow-sm"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>{t("editor.ai.serviceUnavailable")}</span>
        <div className="flex-1" />
        <DismissButton />
      </div>
    )
  }

  if (finished) {
    const took = formatElapsed((progress.endedAt ?? progress.startedAt) - progress.startedAt)
    if (outcome === "done") {
      return (
        <div
          role="status"
          data-testid="completion-batch-status"
          data-outcome="done"
          className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-background px-3 py-2 text-sm shadow-sm"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span>
            {fileName && <span className="font-medium">{fileName}: </span>}
            {t("editor.completion.done", { done, time: took })}
          </span>
          <div className="flex-1" />
          <DismissButton />
        </div>
      )
    }

    const summary =
      outcome === "stopped"
        ? t("editor.completion.stopped", { done, total })
        : outcome === "interrupted"
          ? t("editor.completion.interrupted", { done, total })
          : failed > 0
            ? done > 0
              ? t("editor.completion.failedPartial", { failed, total, done })
              : t("editor.completion.failed", { failed, total })
            : // The loop died before any cell was counted as failed: everything
              // it did not draft is the failure.
              done > 0
              ? t("editor.completion.failedPartial", { failed: total - done, total, done })
              : t("editor.completion.failed", { failed: total - done, total })
    const loud = outcome === "failed"
    return (
      <div
        role={loud ? "alert" : "status"}
        data-testid="completion-batch-status"
        data-outcome={outcome ?? "failed"}
        className={`rounded-md border bg-background px-3 py-2 text-sm shadow-sm ${
          loud ? "border-destructive/40" : "border-amber-500/40"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${loud ? "text-destructive" : "text-amber-600"}`} />
          <span>
            {fileName && <span className="font-medium">{fileName}: </span>}
            {summary}
          </span>
          <div className="flex-1" />
          <RetryRemainder
            progress={progress}
            labelKey={loud ? "editor.completion.retryRemaining" : "editor.completion.resumeRemaining"}
          />
          <DismissButton />
        </div>
        {loud && <FailedCellsLines progress={progress} />}
      </div>
    )
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div
      role="status"
      data-testid="completion-batch-status"
      data-outcome={stalled ? "stalled" : "running"}
      className={`rounded-md border bg-background px-3 py-2 text-sm ${
        stalled ? "border-amber-500/60" : ""
      } ${variant === "floating" ? "shadow-sm" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="max-w-[40%] truncate font-medium">
          {fileName
            ? t("editor.completion.translatingFile", { file: fileName })
            : t("editor.completion.translating")}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        <RunningClock startedAt={progress.startedAt} />
        {!cancelled && !stalled && (
          <AppTooltip content={t("editor.completion.stop")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={cancelBatchCompletion}
              aria-label={t("editor.completion.stop")}
              className="ms-1 text-muted-foreground"
            >
              <X />
            </Button>
          </AppTooltip>
        )}
        {cancelled && (
          <span className="text-muted-foreground">{t("common.cancelling")}</span>
        )}
      </div>
      {stalled && (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span>
            {t("editor.completion.stalled", { minutes: Math.round(STALL_CEILING_MS / 60_000) })}
          </span>
          <div className="flex-1" />
          <RetryRemainder progress={progress} labelKey="editor.completion.retryRemaining" />
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={cancelBatchCompletion}
          >
            {t("common.stop")}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * AQU-2654: the batch outlives the gesture that started it and the page it
 * was started on — the loop keeps drafting after the user leaves the editor.
 * Mounted once at the app root, this shows the same banner wherever the
 * editor's inline one is not on screen, and restores an interrupted run's
 * terminal state after a reload.
 */
export function CompletionBatchStatusHost() {
  const inlineMounted = useInlineBatchCompletionBannerMounted()
  useEffect(() => {
    void restoreInterruptedBatchCompletion()
  }, [])
  if (inlineMounted) return null
  return (
    <div className="fixed bottom-4 left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 empty:hidden">
      <CompletionBulkProgressBanner variant="floating" />
    </div>
  )
}
