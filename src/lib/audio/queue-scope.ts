// Scoping the singleton play-queue to ONE file. (AQU-646)
//
// The queue is a module singleton, so a stale queue still playing file A must
// not drive file B's timeline, its playhead, or its linked video. Every field a
// consumer reads needs the same "is this cell mine?" guard, and a consumer that
// guards its caption but not its transport is a bug that only appears with two
// files open — so the guard is written once, here.
//
// It lives in its own module rather than inside play-queue.ts so that a test
// mocking the queue's hooks can still exercise the REAL scoping rule instead of
// re-implementing it in a stub that is free to drift.

import type { QueueProgress, QueueState } from "./play-queue"

export interface QueueForFile {
  /** Playing, paused or loading THIS file — i.e. the clock means something. */
  active: boolean
  /** Strictly sounding. Playhead interpolation parks when this is false. */
  playing: boolean
  /** Playing or loading. A cold verse boundary dips through `loading`, and
   *  follow/re-engage must not read that dip as a stop. */
  running: boolean
  /** The queue's cell, null unless it belongs to this file. */
  cellId: string | null
  /** Scoped state: another file's playback reads as `idle` here, so a consumer
   *  that switches on `kind` alone still cannot be hijacked. */
  kind: QueueState["kind"]
  progress: QueueProgress
}

export function selectQueueForFile(
  state: QueueState,
  progress: QueueProgress,
  cellIds: ReadonlySet<string>,
): QueueForFile {
  const cellId =
    "cellId" in state && state.cellId != null && cellIds.has(state.cellId) ? state.cellId : null
  const mine = cellId != null
  return {
    active: mine && (state.kind === "playing" || state.kind === "paused" || state.kind === "loading"),
    playing: mine && state.kind === "playing",
    running: mine && (state.kind === "playing" || state.kind === "loading"),
    cellId,
    kind: mine ? state.kind : "idle",
    progress,
  }
}
