// Which part of a clip actually plays for a line, in the clip's own seconds.
// (AQU-1217, 2026-09-25)
//
// Every waveform off the timeline used to play and draw the WHOLE file: the
// Recording tab ignored a take's stored trim, and on an imported source-audio
// section it played the entire source reading instead of the section. The
// timeline never had that bug because `targetChipGeom` reads the window. This
// is the same answer for surfaces that have a cell and an attachment but no
// timeline geometry.
//
// Two kinds of window, and they must not be confused:
//
//   - A TAKE's window is its stored trim (`trimStartMs`/`trimEndMs`). Null on a
//     side means "to the clip's edge". It is editable.
//   - The IMPORTED SOURCE CLIP is one file shared by every section of the
//     reading, so a section's window is the section's own timing
//     (`startTime`/`endTime`), on the clip's clock because the clip starts at
//     file zero. It is NOT the attachment trim: that holds the tight speech
//     bounds detected for transcription. It is not editable here — retime the
//     section on the timeline instead.

import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { audioIdSeededWith } from "@/lib/audio/upload"

export interface KeptWindow {
  /** Seconds into the clip, or null for the clip's start. */
  start: number | null
  /** Seconds into the clip, or null for the clip's end. */
  end: number | null
  /** Where the window came from. Only a `trim` may be edited in place. */
  kind: "trim" | "section" | "none"
}

interface CellShape {
  id: string
  medium?: string
  selectedAudioId?: string
  startTime?: number
  endTime?: number
}

/**
 * True when `audioId` is the cell's imported source clip rather than a take.
 * Same test as the Audio view has used since round 5: the source clip sits in
 * the recording slot but is seeded with the FILE id, never this cell's.
 */
export function isSourceClipFor(cell: CellShape, audioId: string | null | undefined): boolean {
  return (
    cell.medium === "media" &&
    audioId != null &&
    audioId === cell.selectedAudioId &&
    !audioIdSeededWith(audioId, cell.id)
  )
}

const NONE: KeptWindow = { start: null, end: null, kind: "none" }

export function keptWindowSec(
  cell: CellShape,
  audioId: string | null | undefined,
  att: Pick<CodexCellAttachment, "trimStartMs" | "trimEndMs"> | undefined,
): KeptWindow {
  if (!audioId) return NONE
  if (isSourceClipFor(cell, audioId)) {
    const { startTime, endTime } = cell
    return typeof startTime === "number" && Number.isFinite(startTime) &&
      typeof endTime === "number" && Number.isFinite(endTime) && endTime > startTime
      ? { start: startTime, end: endTime, kind: "section" }
      : NONE
  }
  if (!att) return NONE
  const startMs = typeof att.trimStartMs === "number" && Number.isFinite(att.trimStartMs) && att.trimStartMs > 0
    ? att.trimStartMs
    : null
  const endMs = typeof att.trimEndMs === "number" && Number.isFinite(att.trimEndMs) && att.trimEndMs > (startMs ?? 0)
    ? att.trimEndMs
    : null
  if (startMs == null && endMs == null) return NONE
  return { start: startMs == null ? null : startMs / 1000, end: endMs == null ? null : endMs / 1000, kind: "trim" }
}

/** AQU-1767: a split take's pieces on the recording's clock, in seconds. */
export interface PiecesWindow {
  /** The first piece's start and the last piece's end (null = the clip's end). */
  start: number
  end: number | null
  /** Stretches between pieces that do not play. */
  gaps: { start: number; end: number }[]
  /** Where one piece ends exactly where the next begins: the cuts. */
  cuts: number[]
}

/**
 * AQU-1767 (Sam, 2026-10-14): where a split take's pieces sit in the recording
 * they share, so its waveform can show them lit, the cuts marked and the
 * space between them faded — and its player can skip that space.
 */
export function piecesWindowSec(
  pieces: ReadonlyArray<{ trimStartMs?: number | null; trimEndMs?: number | null }>,
): PiecesWindow {
  const spans = pieces
    .map((p) => ({ start: (p.trimStartMs ?? 0) / 1000, end: p.trimEndMs == null ? Infinity : p.trimEndMs / 1000 }))
    .sort((a, b) => a.start - b.start)
  const cuts: number[] = []
  const merged: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(span.start - last.end) < 0.001) cuts.push(span.start)
    if (last && span.start <= last.end + 0.001) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  const gaps = merged.slice(1).map((m, i) => ({ start: merged[i].end, end: m.start }))
  const end = merged.length > 0 ? merged[merged.length - 1].end : Infinity
  return { start: merged[0]?.start ?? 0, end: Number.isFinite(end) ? end : null, gaps, cuts }
}
