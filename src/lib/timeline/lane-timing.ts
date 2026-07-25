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

/**
 * Where a section's dub chip sits and how long it is. Start = target_start_ms
 * (default: the section start); length = the recording's effective duration,
 * falling back to the section span when unknown (legacy takes without
 * durationMs) — `usingFallback` marks that case for the UI.
 */
export function targetChipSpanSec(
  cell: CellData,
  att: Pick<CodexCellAttachment, "durationMs" | "trimStartMs" | "trimEndMs"> | undefined,
): (SpanSec & { usingFallback: boolean }) | null {
  const section = sectionSpanSec(cell)
  if (!section) return null
  const startMs = metaNumber(cell.metadata, "target_start_ms")
  const start = startMs != null ? startMs / 1000 : section.start
  const durMs = effectiveAttachmentDurationMs(att)
  if (durMs == null) {
    return { start, end: start + (section.end - section.start), usingFallback: true }
  }
  return { start, end: start + durMs / 1000, usingFallback: false }
}

/** When (file seconds) a section's dub is due to fire during playback. */
export function targetDueSec(cell: CellData): number | null {
  const startMs = metaNumber(cell.metadata, "target_start_ms")
  if (startMs != null) return startMs / 1000
  return sectionSpanSec(cell)?.start ?? null
}

/**
 * How worried the UI should be about a chip's tail: "soft" when it runs
 * meaningfully past its section's end, "cutoff" when it reaches the NEXT
 * section's chip — that dub will audibly cut this one off.
 */
export function chipOverflowState(
  chipEndSec: number,
  sectionEndSec: number,
  nextChipStartSec: number | null,
): "none" | "soft" | "cutoff" {
  if (nextChipStartSec != null && chipEndSec > nextChipStartSec) return "cutoff"
  if (chipEndSec > sectionEndSec + OVERFLOW_SOFT_SEC) return "soft"
  return "none"
}
