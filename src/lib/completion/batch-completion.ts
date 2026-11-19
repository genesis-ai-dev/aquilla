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

/**
 * How a run ended (AQU-2654). A run that is over ALWAYS carries one of these
 * and stays in the store until the user dismisses it or starts another run:
 * a batch that stops without saying so is indistinguishable from a slow one.
 *   - `done`        every requested cell was drafted.
 *   - `stopped`     the user pressed Stop; the remainder was never attempted.
 *   - `failed`      at least one cell was not drafted, or the loop itself died.
 *   - `interrupted` the page was reloaded / discarded mid-run (restored from
 *                   sessionStorage on the next load; nothing is running).
 */
export type CompletionBatchOutcome = "done" | "stopped" | "failed" | "interrupted"

export interface CompletionBatchFailedCell {
  cellId: string
  /** Human label for the cell (verse reference / row label) when it has one. */
  label?: string
  reason: string
}

/** Where the run is happening, so a surface outside the editor can name it
 *  and link back to it. */
export interface CompletionBatchScope {
  projectId?: string
  fileId?: string
  fileName?: string
}

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
   * True once the run is over and this object is retained only to show its
   * terminal state (`outcome`). False while cells are still being generated.
   */
  finished: boolean
  /** Run this progress belongs to (0 for a run restored after a reload). */
  runId: number
  /** `Date.now()` when the run started / ended. */
  startedAt: number
  endedAt: number | null
  /** Null while running; set exactly once when the run is over. */
  outcome: CompletionBatchOutcome | null
  scope: CompletionBatchScope
  /** The first few failed cells, by name, for the failure summary. `failed`
   *  is the count; this list is capped at MAX_FAILED_CELLS_LISTED. */
  failedCells: CompletionBatchFailedCell[]
  /** Requested cells that have not been drafted (failed + never attempted).
   *  What "retry the remainder" drafts. Empty when the ids were not supplied. */
  remainingCellIds: string[]
  /** Watchdog: nothing has moved for STALL_CEILING_MS (no stream delta, no
   *  retrieval, no commit). The run is still nominally live. */
  stalled: boolean
  /** Why the loop itself died, when it did (as opposed to per-cell failures). */
  runError?: string
  /**
   * AQU-1377: the run was refused before it started because the AI service is
   * unreachable. `completeBatch` used to `return` silently here, so clicking
   * Translate on a selection did nothing at all — no banner, no drafts, no
   * error. This flag lets the banner say so instead of the click going quiet.
   */
  unavailable?: boolean
}

export const MAX_FAILED_CELLS_LISTED = 20

/**
 * Stall ceiling (AQU-2654). The driver reports activity on every stream delta,
 * every retrieval and every commit, and a single model request is already
 * bounded at 120 s (`COMPLETION_REQUEST_TIMEOUT_MS`), so a slow-but-alive run
 * can never be silent for this long. Reaching it means an await with no
 * timeout of its own is hung (a dead connection during retrieval, a wedged
 * flush) or the tab was suspended.
 */
export const STALL_CEILING_MS = 5 * 60_000
const WATCHDOG_TICK_MS = 15_000
/** A watchdog tick this late means timers did not run at all (machine asleep,
 *  tab frozen) — not that the run was silent. Give it a fresh ceiling. */
const SUSPENDED_TICK_GAP_MS = 2 * 60_000

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
  persistRunning()
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
  if (!_progress || _progress.finished) return
  if (_progress.stalled) {
    // AQU-2654: a stalled run is parked on an await the abort signal may not
    // reach, so its loop might never get to its own exit. End it here: the
    // terminal state shows now, and retiring the run id turns anything the
    // old loop does if it ever wakes into a no-op.
    finishBatchCompletion(_currentRunId)
    _currentRunId = _currentRunId + 1
    return
  }
  // Update the banner immediately so it shows "cancelling…"
  setCompletionBatchProgress({ ..._progress, cancelled: true })
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
export function resetBatchCompletionState(
  total: number,
  opts: { scope?: CompletionBatchScope; cellIds?: readonly string[] } = {},
): number {
  // Supersede any live run — abort its signal and set the flag.
  // Do this BEFORE bumping _currentRunId so the old run's final
  // isBatchCompletionCancelled(oldId) sees true and exits cleanly.
  if (_progress !== null) {
    _cancelFlag = true
    _abortController?.abort()
  }
  stopRunGuards()

  _currentRunId = _currentRunId + 1
  const runId = _currentRunId

  _cancelFlag = false
  _abortController = new AbortController()
  const now = Date.now()
  _lastActivityAt = now
  startRunGuards(runId)
  setCompletionBatchProgress({
    total,
    done: 0,
    cancelled: false,
    failed: 0,
    finished: false,
    runId,
    startedAt: now,
    endedAt: null,
    outcome: null,
    scope: opts.scope ?? {},
    failedCells: [],
    remainingCellIds: opts.cellIds ? [...opts.cellIds] : [],
    stalled: false,
  })
  return runId
}

/**
 * The ONE exit of a run (AQU-2654): every path out of the driver loop —
 * finished, stopped, a chunk that failed, or an exception nobody expected —
 * lands here and leaves a terminal state on screen. Nothing clears it but the
 * user (dismissBatchCompletionSummary) or the next run.
 *
 * `error` is the reason the loop itself died; pass it from the driver's catch.
 * No-op for a superseded run, like every other runId-guarded call.
 */
export function finishBatchCompletion(runId: number, opts: { error?: unknown } = {}) {
  if (runId !== _currentRunId) return
  stopRunGuards()
  _abortController = null
  if (!_progress || _progress.finished) return
  const died = opts.error !== undefined
  const stopped = _cancelFlag || _progress.cancelled
  const outcome: CompletionBatchOutcome = died
    ? "failed"
    : stopped
      ? "stopped"
      : _progress.failed > 0 || _progress.done < _progress.total
        ? "failed"
        : "done"
  setCompletionBatchProgress({
    ..._progress,
    cancelled: false,
    finished: true,
    stalled: false,
    endedAt: Date.now(),
    outcome,
    ...(died
      ? { runError: opts.error instanceof Error ? opts.error.message : String(opts.error) }
      : {}),
  })
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
  stopRunGuards()
  if (_progress && _progress.failed > 0) {
    // Keep the summary visible (marked finished); just release the abort
    // controller — the run itself is over.
    setCompletionBatchProgress({
      ..._progress,
      finished: true,
      stalled: false,
      endedAt: _progress.endedAt ?? Date.now(),
      outcome: _progress.outcome ?? "failed",
    })
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
  stopRunGuards()
  setCompletionBatchProgress(null)
  _abortController = null
}

/**
 * AQU-1377: report that a batch was refused before it started because the AI
 * service is unreachable. Supersedes any retained summary so the newest thing
 * the user did is what the banner talks about, and marks the pseudo-run
 * `finished` so nothing treats it as live progress. Dismissed by the same
 * dismissBatchCompletionSummary() the failure summary uses.
 */
export function reportBatchCompletionUnavailable() {
  // Never talk over a run that is still generating: its progress bar is the more
  // useful thing on screen, and a refused second click already has that banner
  // as feedback. Only a finished summary (or an idle store) is replaced.
  if (_progress && !_progress.finished) return
  const now = Date.now()
  setCompletionBatchProgress({
    total: 0,
    done: 0,
    cancelled: false,
    failed: 0,
    finished: true,
    unavailable: true,
    runId: 0,
    startedAt: now,
    endedAt: now,
    outcome: "failed",
    scope: {},
    failedCells: [],
    remainingCellIds: [],
    stalled: false,
  })
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

/**
 * One store transition for a whole committed chunk (AQU-2654): the ten cells
 * of a model response are announced once, not ten times.
 */
export function recordBatchCompletionDone(runId: number, cellIds: readonly string[]) {
  if (runId !== _currentRunId || !_progress || cellIds.length === 0) return
  const drafted = new Set(cellIds)
  _lastActivityAt = Date.now()
  setCompletionBatchProgress({
    ..._progress,
    done: _progress.done + cellIds.length,
    cancelled: _cancelFlag,
    stalled: false,
    remainingCellIds: _progress.remainingCellIds.filter((id) => !drafted.has(id)),
  })
}

/** Failed cells BY NAME, one transition. They stay in `remainingCellIds` so
 *  "retry the remainder" picks them up. */
export function recordBatchCompletionFailed(
  runId: number,
  cells: readonly CompletionBatchFailedCell[],
) {
  if (runId !== _currentRunId || !_progress || cells.length === 0) return
  _lastActivityAt = Date.now()
  setCompletionBatchProgress({
    ..._progress,
    failed: _progress.failed + cells.length,
    cancelled: _cancelFlag,
    stalled: false,
    failedCells: [..._progress.failedCells, ...cells].slice(0, MAX_FAILED_CELLS_LISTED),
  })
}

// ---------------------------------------------------------------------------
// Stall watchdog
// ---------------------------------------------------------------------------

let _lastActivityAt = 0
let _watchdog: ReturnType<typeof setInterval> | null = null
let _lastTickAt = 0

/**
 * The driver calls this whenever the run demonstrably moved: a stream delta
 * arrived, retrieval returned, a chunk was saved. Cheap by design (one number)
 * because it runs per delta; it only notifies when it clears a stall flag.
 */
export function noteBatchCompletionActivity(runId: number) {
  if (runId !== _currentRunId) return
  _lastActivityAt = Date.now()
  if (_progress?.stalled && !_progress.finished) {
    setCompletionBatchProgress({ ..._progress, stalled: false })
  }
}

function checkStall() {
  const now = Date.now()
  const suspended = _lastTickAt > 0 && now - _lastTickAt > SUSPENDED_TICK_GAP_MS
  _lastTickAt = now
  if (!_progress || _progress.finished) return
  if (suspended) {
    // Timers were not running at all; the silence proves nothing yet.
    _lastActivityAt = now
    return
  }
  if (!_progress.stalled && now - _lastActivityAt >= STALL_CEILING_MS) {
    setCompletionBatchProgress({ ..._progress, stalled: true })
  }
}

// ---------------------------------------------------------------------------
// Tab-lifetime guards: Web Lock + watchdog
// ---------------------------------------------------------------------------

// A page that holds a Web Lock is exempt from Chromium's background-tab
// freezing (Energy Saver, Chrome 133+: "Hold a Web Lock or an IndexedDB
// connection that blocks operations outside the group"). The batch is a
// client-side loop, so a frozen tab is a dead batch; holding a lock for the
// run's lifetime is the platform's own way to say "background work in
// progress". The name is unique per run so it never contends with another tab,
// and doubles as the liveness probe for restoreInterruptedBatchCompletion().
let _releaseLock: (() => void) | null = null
let _lockName: string | null = null

// Closing or reloading the tab is the one way of leaving that DOES end the
// run (in-app navigation does not). Say so before it happens, with the
// browser's own "leave site?" prompt — the same convention as unsaved project
// settings and unsynced offline work.
function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ""
}

function startRunGuards(runId: number) {
  _lastTickAt = Date.now()
  _watchdog = setInterval(checkStall, WATCHDOG_TICK_MS)
  if (typeof document !== "undefined") {
    // Timers are throttled to one a minute in a long-hidden tab; coming back
    // to it is the moment the user most needs the truth.
    document.addEventListener("visibilitychange", checkStall)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", warnBeforeUnload)
  }
  _lockName = null
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  if (!locks) return
  const name = `aquilla-batch-completion:${runId}:${Math.random().toString(36).slice(2)}`
  _lockName = name
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  _releaseLock = release
  void locks.request(name, () => held).catch(() => { /* the lock is best-effort */ })
}

function stopRunGuards() {
  if (_watchdog !== null) clearInterval(_watchdog)
  _watchdog = null
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", checkStall)
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", warnBeforeUnload)
  }
  _releaseLock?.()
  _releaseLock = null
  _lockName = null
}

// ---------------------------------------------------------------------------
// Reload / discard survival
// ---------------------------------------------------------------------------

// The loop lives in this tab's memory. A reload, a crash, or the browser
// discarding the tab ends it with nobody left to say so — unless the next page
// load can tell that a run was in flight. sessionStorage is per tab and is
// restored with a discarded tab, which is exactly the scope needed.
const PERSIST_KEY = "aquilla.batchCompletion.v1"

interface PersistedRun {
  v: 1
  lockName: string | null
  total: number
  done: number
  failed: number
  startedAt: number
  scope: CompletionBatchScope
  failedCells: CompletionBatchFailedCell[]
  remainingCellIds: string[]
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null
  } catch {
    return null
  }
}

function persistRunning() {
  const store = sessionStore()
  if (!store) return
  try {
    // Only a RUNNING run is worth restoring; an `interrupted` one is kept as
    // written (so a second reload still shows it) until it is dismissed.
    if (_progress && !_progress.finished) {
      const record: PersistedRun = {
        v: 1,
        lockName: _lockName,
        total: _progress.total,
        done: _progress.done,
        failed: _progress.failed,
        startedAt: _progress.startedAt,
        scope: _progress.scope,
        failedCells: _progress.failedCells,
        remainingCellIds: _progress.remainingCellIds,
      }
      store.setItem(PERSIST_KEY, JSON.stringify(record))
    } else if (!_progress || _progress.outcome !== "interrupted") {
      store.removeItem(PERSIST_KEY)
    }
  } catch {
    // Quota / privacy mode: the run itself is unaffected.
  }
}

/**
 * Called once at app start. If this tab was drafting when it went away, show
 * that as a terminal `interrupted` state with the remainder ready to resume —
 * instead of an editor that looks as if nothing had been running.
 */
export async function restoreInterruptedBatchCompletion(): Promise<void> {
  const store = sessionStore()
  if (!store || _progress) return
  let record: PersistedRun
  try {
    const raw = store.getItem(PERSIST_KEY)
    if (!raw) return
    record = JSON.parse(raw) as PersistedRun
    if (record.v !== 1 || typeof record.total !== "number") {
      store.removeItem(PERSIST_KEY)
      return
    }
  } catch {
    return
  }
  // A duplicated tab copies sessionStorage. If the run's lock is still held,
  // the run is alive in the original tab and this copy is not ours to report.
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  if (record.lockName && locks?.query) {
    try {
      const state = await locks.query()
      if (state.held?.some((lock) => lock.name === record.lockName)) {
        store.removeItem(PERSIST_KEY)
        return
      }
    } catch {
      // Without the probe, report the interruption.
    }
  }
  if (_progress) return
  _progress = {
    total: record.total,
    done: record.done,
    cancelled: false,
    failed: record.failed,
    finished: true,
    runId: 0,
    startedAt: record.startedAt,
    endedAt: null,
    outcome: "interrupted",
    scope: record.scope ?? {},
    failedCells: record.failedCells ?? [],
    remainingCellIds: record.remainingCellIds ?? [],
    stalled: false,
  }
  notify()
}

// ---------------------------------------------------------------------------
// Resume / retry the remainder
// ---------------------------------------------------------------------------

/** Drafts the still-untranslated cells among `cellIds` in the workspace that
 *  registered it. Returns false when none of them are loaded there (another
 *  file is open), so the caller can send the user to the file instead. */
export type BatchCompletionResumer = (cellIds: readonly string[]) => boolean

const _resumers = new Map<string, BatchCompletionResumer>()

/** The mounted workspace's useCompletion registers itself per project, so the
 *  status surface restarts the remainder through a LIVE driver rather than
 *  through the closure of a run that is hung or gone. */
export function registerBatchCompletionResumer(
  projectId: string,
  resumer: BatchCompletionResumer,
): () => void {
  _resumers.set(projectId, resumer)
  return () => {
    if (_resumers.get(projectId) === resumer) _resumers.delete(projectId)
  }
}

/**
 * Retry / resume: draft what the current (stalled or finished) run left
 * undone. Starting the new run supersedes the old one through the run-id
 * guards, so a hung loop can never save or count after this.
 */
export function resumeBatchCompletion(): boolean {
  if (!_progress || _progress.remainingCellIds.length === 0) return false
  const projectId = _progress.scope.projectId
  const resumer = projectId ? _resumers.get(projectId) : undefined
  if (!resumer) return false
  return resumer(_progress.remainingCellIds)
}

// ---------------------------------------------------------------------------
// Where the status is shown
// ---------------------------------------------------------------------------

// The editor shows the banner inline. Anywhere else in the app the same
// banner is shown floating (CompletionBatchStatusHost), so a run started in
// the editor stays visible on Settings, the org pages, and so on. The inline
// banner announces itself here so the floating one stands down meanwhile.
let _inlineBanners = 0

export function registerInlineBatchCompletionBanner(): () => void {
  _inlineBanners += 1
  notify()
  return () => {
    _inlineBanners -= 1
    notify()
  }
}

function hasInlineBanner(): boolean {
  return _inlineBanners > 0
}

export function useInlineBatchCompletionBannerMounted(): boolean {
  return useSyncExternalStore(subscribe, hasInlineBanner, () => false)
}
