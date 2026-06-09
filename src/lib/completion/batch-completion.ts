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

import { useSyncExternalStore } from "react"

// ---------------------------------------------------------------------------
// Progress store
// ---------------------------------------------------------------------------

export interface CompletionBatchProgress {
  total: number
  done: number
  /** True once Stop has been requested; loop will not start new cells. */
  cancelled: boolean
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

/** Whether a Stop has been requested (checked between cells). */
export function isBatchCompletionCancelled(): boolean {
  return _cancelFlag
}

/**
 * Returns the current AbortController's signal for passing to complete().
 * Callers must call this after resetBatchCompletionState() to get a fresh signal.
 */
export function getBatchCompletionSignal(): AbortSignal {
  if (!_abortController) _abortController = new AbortController()
  return _abortController.signal
}

/** Called at the start of a new batch run to clear any stale cancel state. */
export function resetBatchCompletionState(total: number) {
  _cancelFlag = false
  _abortController = new AbortController()
  setCompletionBatchProgress({ total, done: 0, cancelled: false })
}

/** Called when the batch finishes (success, cancel, or error) to clear the banner. */
export function clearBatchCompletionProgress() {
  setCompletionBatchProgress(null)
  _abortController = null
}

/** Increment done count and refresh the banner. */
export function incrementBatchCompletionDone() {
  if (!_progress) return
  const next = { ..._progress, done: _progress.done + 1, cancelled: _cancelFlag }
  setCompletionBatchProgress(next)
}
