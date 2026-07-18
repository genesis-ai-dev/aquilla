// Batch AI completion driver — mirrors the pattern from batch-audio.ts.
//
// Provides:
//   1. A lightweight pub-sub progress store (useSyncExternalStore-compatible).
//   2. A cancellation flag + cancelBatchCompletion() exported for the banner.
//   3. runBatchCompletion() — the sequential driver called from useCompletion.
//
// Abort semantics (chosen):
//   - The cancel flag stops the driver loop between cells, so no NEW cells
//     start after the user clicks Stop.
//   - The AbortController.abort() call is issued immediately so the
//     *in-flight* fetch/stream is also killed by the browser via the signal.
//   - Any cell that was already committed before Stop is clicked keeps its
//     committed translation. Partial streaming text that was NOT yet committed
//     is discarded (the caller clears previews/completing state on abort).
//   - This matches the audio batch pattern: "in-flight cells may still
//     complete" (audio) vs. here "in-flight request is actively aborted".
//
// Run-identity semantics (AQU-235 fix):
//   - resetBatchCompletionState() returns a numeric run ID (monotonic counter).
//   - Every stateful mutation (clearBatchCompletionProgress, incrementBatchCompletionDone,
//     isBatchCompletionCancelled, getBatchCompletionSignal) takes an optional runId.
//     When runId !== _currentRunId the call is a no-op — it belongs to a
//     superseded run and must not affect the live run.
//   - Supersede semantics: if completeBatch is called while a batch is already
//     live, resetBatchCompletionState cancels the old run before starting the
//     new one. This is preferable to refusing: the user clicking "Translate all"
//     again clearly intends a fresh run.

import { useSyncExternalStore } from "react"

// ---------------------------------------------------------------------------
// Progress store
// ---------------------------------------------------------------------------

export interface CompletionBatchProgress {
  total: number
  done: number
  /** True once Stop has been requested; loop will not start new cells. */
  cancelled: boolean
  /**
   * Cells that failed after retry and were skipped so the rest of the run
   * could continue (AQU-361). Included in the end-of-run summary so a
   * partial failure is never silent.
   */
  failed: number
  /**
   * True once the run has finished (successfully or with failures) and this
   * progress object is being retained only to show the end-of-run summary
   * (AQU-361). False while cells are still actively being generated.
   */
  finished: boolean
}

let _progress: CompletionBatchProgress | null = null
const _listeners = new Set<() => void>()

function notify() {
  for (const l of _listeners) l()
}

export function getCompletionBatchProgress(): CompletionBatchProgress | null {
  return _progress
}

function setCompletionBatchProgress(p: CompletionBatchProgress | null) {
  _progress = p
  notify()
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}

export function useCompletionBatchProgress(): CompletionBatchProgress | null {
  return useSyncExternalStore(subscribe, getCompletionBatchProgress, () => null)
}

// ---------------------------------------------------------------------------
// Run identity — monotonic counter
// ---------------------------------------------------------------------------

let _currentRunId = 0

/** Returns the run ID that is currently live (0 = no batch running). */
export function getCurrentBatchRunId(): number {
  return _currentRunId
}

// ---------------------------------------------------------------------------
// Cancel flag + AbortController handle
// ---------------------------------------------------------------------------

let _cancelFlag = false
let _abortController: AbortController | null = null

export function cancelBatchCompletion() {
  _cancelFlag = true
  _abortController?.abort()
  // Update the banner immediately so it shows "cancelling…"
  if (_progress) {
    setCompletionBatchProgress({ ..._progress, cancelled: true })
  }
}

/**
 * Whether a Stop has been requested (checked between cells).
 * Pass the run ID returned by resetBatchCompletionState so a superseded run
 * does not read a false-negative after the new run clears the flag.
 */
export function isBatchCompletionCancelled(runId?: number): boolean {
  if (runId !== undefined && runId !== _currentRunId) {
    // This run has been superseded — treat it as cancelled so it stops cleanly.
    return true
  }
  return _cancelFlag
}

/**
 * Returns the current AbortController's signal for passing to complete().
 * Callers must call this after resetBatchCompletionState() to get a fresh signal.
 * If the runId doesn't match the current run, returns an already-aborted signal
 * so the stale call terminates immediately.
 */
export function getBatchCompletionSignal(runId?: number): AbortSignal {
  if (runId !== undefined && runId !== _currentRunId) {
    // Return an already-aborted signal so the stale caller's fetch terminates.
    const stale = new AbortController()
    stale.abort()
    return stale.signal
  }
  if (!_abortController) _abortController = new AbortController()
  return _abortController.signal
}

/**
 * Called at the start of a new batch run to clear any stale cancel state.
 * Returns the new run ID — callers MUST capture this and pass it to
 * isBatchCompletionCancelled / getBatchCompletionSignal / clearBatchCompletionProgress
 * / incrementBatchCompletionDone so superseded runs cannot affect the live run.
 *
 * If a batch is already running it is superseded (cancelled) before the new
 * run ID is allocated: the old controller is aborted so in-flight fetches
 * terminate, and the old run's flag checks will see "superseded = cancelled".
 */
export function resetBatchCompletionState(total: number): number {
  // Supersede any live run — abort its signal and set the flag.
  // Do this BEFORE bumping _currentRunId so the old run's final
  // isBatchCompletionCancelled(oldId) sees true and exits cleanly.
  if (_progress !== null) {
    _cancelFlag = true
    _abortController?.abort()
  }

  _currentRunId = _currentRunId + 1
  const runId = _currentRunId

  _cancelFlag = false
  _abortController = new AbortController()
  setCompletionBatchProgress({ total, done: 0, cancelled: false, failed: 0, finished: false })
  return runId
}

/**
 * Called when the batch finishes (success, cancel, or error) to clear the banner.
 * The runId guard prevents a finishing run A from clearing run B's banner.
 *
 * AQU-361: if the run ended with any failed (skipped) cells, the progress is
 * NOT cleared here — it is left in place (with `cancelled: false`) so the
 * banner can render an honest "X of N cells failed" summary instead of the
 * run going quiet. The caller dismisses it explicitly via
 * dismissBatchCompletionSummary() (e.g. clicking the banner's close button).
 */
export function clearBatchCompletionProgress(runId?: number) {
  if (runId !== undefined && runId !== _currentRunId) return
  if (_progress && _progress.failed > 0) {
    // Keep the summary visible (marked finished); just release the abort
    // controller — the run itself is over.
    setCompletionBatchProgress({ ..._progress, finished: true })
    _abortController = null
    return
  }
  setCompletionBatchProgress(null)
  _abortController = null
}

/**
 * Explicitly dismiss a completed run's failure summary (e.g. banner close
 * button, or starting to retry the failed cells). Unlike
 * clearBatchCompletionProgress, this always clears regardless of `failed`.
 */
export function dismissBatchCompletionSummary() {
  setCompletionBatchProgress(null)
  _abortController = null
}

/**
 * Increment done count and refresh the banner.
 * The runId guard prevents a stale run from inflating run B's counter.
 */
export function incrementBatchCompletionDone(runId?: number) {
  if (runId !== undefined && runId !== _currentRunId) return
  if (!_progress) return
  const next = { ..._progress, done: _progress.done + 1, cancelled: _cancelFlag }
  setCompletionBatchProgress(next)
}

/**
 * Record cells that failed (after retry) and were skipped so the run could
 * continue (AQU-361). Same run-id guard as incrementBatchCompletionDone: a
 * superseded run's failures must not pollute the live run's summary.
 */
export function incrementBatchCompletionFailed(runId?: number, count = 1) {
  if (runId !== undefined && runId !== _currentRunId) return
  if (!_progress) return
  const next = { ..._progress, failed: _progress.failed + count, cancelled: _cancelFlag }
  setCompletionBatchProgress(next)
}
