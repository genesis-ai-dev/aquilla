// Per-lane timing resolution (AQU-646 round 6). The cell's start/end is the
// FROZEN source split; the subtitle lane and the target-audio lane may carry
// their own spans via metadata keys written by cell.lane.retime:
//   subtitle_start_ms / subtitle_end_ms — the subtitle card's independent span
//   target_start_ms — where the dub actually starts (absolute file ms)
// A target chip's LENGTH is never stored: it is the recording's effective
// duration (trim-aware). All helpers are pure and defensive — corrupt or
// missing metadata falls back to the source split.

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

export interface SpanSec {
  start: number
  end: number
}

/** Threshold past the section end before a chip counts as "running long". */
export const OVERFLOW_SOFT_SEC = 0.5

function metaNumber(meta: CellData["metadata"], key: string): number | null {
  const v = meta?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function sectionSpanSec(cell: CellData): SpanSec | null {
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null
  if (typeof endTime !== "number" || !Number.isFinite(endTime)) return null
  return { start: startTime, end: endTime }
}

/**
 * An attachment's playable length in ms, honoring trims when present.
 * Null when the length simply isn't known (durationMs was never recorded).
 */
export function effectiveAttachmentDurationMs(
  att: Pick<CodexCellAttachment, "durationMs" | "trimStartMs" | "trimEndMs"> | undefined,
): number | null {
  if (!att) return null
  const end = att.trimEndMs ?? att.durationMs ?? null
  if (end == null || !Number.isFinite(end)) return null
  const start = att.trimStartMs != null && Number.isFinite(att.trimStartMs) ? att.trimStartMs : 0
  const dur = end - start
  return dur > 0 ? dur : null
}

/**
 * The span a SUBTITLE card renders/edits. Media cells may carry an
 * independent subtitle span in metadata (seeded = absent → the source split);
 * text cells' own timing IS their subtitle timing.
 */
export function subtitleSpanSec(cell: CellData): SpanSec | null {
  const base = sectionSpanSec(cell)
  if (cell.medium !== "media") return base
  const startMs = metaNumber(cell.metadata, "subtitle_start_ms")
  const endMs = metaNumber(cell.metadata, "subtitle_end_ms")
  if (startMs != null && endMs != null && endMs > startMs) {
    return { start: startMs / 1000, end: endMs / 1000 }
  }
  return base
}

/** A dub chip can't be trimmed shorter than this (matches card MIN_DUR_SEC). */
export const MIN_TARGET_LEN_SEC = 0.2

export interface TargetChipGeom {
  /** File-second where the CLIP'S SAMPLE ZERO sits (= target_start_ms; the
   *  round-7 formalization — playback always cued clips relative to this). */
  anchor: number
  /** Audible start on the file timeline = anchor + trimStart. */
  start: number
  /** Audible end = anchor + (trimEnd ?? duration); section-width fallback. */
  end: number
  trimStartSec: number
  trimEndSec: number | null
  durationSec: number | null
  usingFallback: boolean
}

/**
 * Where a section's dub chip sits and how long it is — CLIP-ZERO ANCHORED
 * (round 7): moving the chip changes only the anchor; trimming the head moves
 * only the left edge (the remaining audio stays put in time, like a DAW
 * region); trimming the tail moves only the right edge. Length falls back to
 * the section span when the recording's duration is unknown (legacy takes) —
 * `usingFallback` marks that case for the UI (movable, not trimmable).
 * Note: takes that were cropped in the voice panel BEFORE round 7 now draw
 * shifted right by their head-trim — the audio itself is unchanged.
 */
export function targetChipGeom(
  cell: CellData,
  att: Pick<CodexCellAttachment, "durationMs" | "trimStartMs" | "trimEndMs"> | undefined,
): TargetChipGeom | null {
  const section = sectionSpanSec(cell)
  if (!section) return null
  const anchorMs = metaNumber(cell.metadata, "target_start_ms")
  const anchor = anchorMs != null ? anchorMs / 1000 : section.start
  const trimStartSec =
    att?.trimStartMs != null && Number.isFinite(att.trimStartMs) && att.trimStartMs > 0
      ? att.trimStartMs / 1000
      : 0
  const durationSec =
    att?.durationMs != null && Number.isFinite(att.durationMs) && att.durationMs > 0
      ? att.durationMs / 1000
      : null
  const trimEndSec =
    att?.trimEndMs != null && Number.isFinite(att.trimEndMs) && att.trimEndMs / 1000 > trimStartSec
      ? att.trimEndMs / 1000
      : null
  const audibleEndOnClip = trimEndSec ?? durationSec
  const start = anchor + trimStartSec
  if (audibleEndOnClip == null) {
    return {
      anchor, start, end: start + (section.end - section.start),
      trimStartSec, trimEndSec: null, durationSec: null, usingFallback: true,
    }
  }
  return {
    anchor, start, end: anchor + audibleEndOnClip,
    trimStartSec, trimEndSec, durationSec, usingFallback: false,
  }
}

/** When (file seconds) a section's dub is due to fire = its AUDIBLE start. */
export function targetDueSec(
  cell: CellData,
  att?: Pick<CodexCellAttachment, "durationMs" | "trimStartMs" | "trimEndMs">,
): number | null {
  return targetChipGeom(cell, att)?.start ?? null
}

/**
 * How worried the UI should be about a chip's tail: "soft" when it runs
 * meaningfully past its section's end, "overlap" when it reaches the NEXT
 * section's chip — both dubs will sound through the overlap (round 7).
 */
export function chipOverflowState(
  chipEndSec: number,
  sectionEndSec: number,
  nextChipStartSec: number | null,
): "none" | "soft" | "overlap" {
  if (nextChipStartSec != null && chipEndSec > nextChipStartSec) return "overlap"
  if (chipEndSec > sectionEndSec + OVERFLOW_SOFT_SEC) return "soft"
  return "none"
}
