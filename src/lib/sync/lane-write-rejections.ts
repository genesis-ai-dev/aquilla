// AQU-1901: which of a flush's dropped rejections are the reader's own edits
// to a line's translation — text or validation — and so must be undone on
// screen and announced rather than left looking saved.
//
// The server answers POST /events with HTTP 200 and lists a refused write in
// `rejected[]` (AQU-1900 made a lane-less write one of those, a 422). The
// flusher drops a non-retryable 4xx, so unless someone listens, the editor
// keeps the typed text, the status chip returns to "Synced", and the edit is
// gone.
//
// Pure, so the selection is tested apart from the 17k-line workspace.

import type { RejectedEntry } from "./outbox-flush"

/** Kinds addressed to a target lane: a line's text and its validation. */
export function isLaneWriteKind(kind: string): boolean {
  return kind.startsWith("target.cell.") || kind === "cell.validate" || kind === "cell.unvalidate"
}

export interface LaneWriteRejection {
  id: string
  cellId: string
  fileId: string | null
  kind: string
  status: number
  reason: string
}

/**
 * The lane-write rejections the workspace must surface. Entries a foreground
 * caller already reported (an AI draft's commit throws into its own row) never
 * get here: its `onRejected` claims them.
 */
export function laneWriteRejections(entries: readonly RejectedEntry[]): LaneWriteRejection[] {
  const out: LaneWriteRejection[] = []
  for (const entry of entries) {
    if (!entry.cellId || !isLaneWriteKind(entry.kind)) continue
    out.push({
      id: entry.id,
      cellId: entry.cellId,
      fileId: entry.fileId,
      kind: entry.kind,
      status: entry.status,
      reason: entry.reason,
    })
  }
  return out
}
