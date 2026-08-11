// Per-lane timing resolution (AQU-646 round 6). The cell's start/end is the
// source split; the subtitle lane and the target-audio lane may carry their own
// spans via metadata keys written by cell.lane.retime:
//   subtitle_start_ms / subtitle_end_ms — the subtitle card's independent span
//   target_offset_ms — where the dub starts, RELATIVE to the cell's own start
//   target_start_ms — the same thing as an absolute file ms (legacy, read-only)
// A target chip's LENGTH is never stored: it is the recording's effective
// duration (trim-aware). All helpers are pure and defensive — corrupt or
// missing metadata falls back to the source split.
//
// Round 8: the source split stopped being frozen — the video-first workflow
// lets a user-added line move — so an ABSOLUTE dub anchor was wrong. It made a
// take stop following its line the moment anyone nudged it, and it made
// chipTrespass/chipOverflowState fire with no user intent, because moving a cue
// moved the section out from under a chip that stayed put. An offset is
// invariant under moving the cue, so both problems go away at the source.

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

export interface SpanSec {
  start: number
  end: number
}

/** Threshold past the section end before a chip counts as "running long". */
export const OVERFLOW_SOFT_SEC = 0.5

/** Sub-perceptual slack before neighbouring chips count as overlapping —
 *  drag/trim maths land within a few ms of an edge, and a "−0.0s" warning is
 *  a lie (2026-08-06: Sam hit exactly that). Below the display's own 0.1s
 *  resolution. */
export const OVERLAP_EPS_SEC = 0.05

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

/**
 * AQU-646: below this, a section is very likely a mistake — a rounding gap
 * between two cues rather than a place anyone meant to put something. The user
 * is TOLD and may carry on regardless; it is never a block (Sam, 2026-08-11).
 * Lives here beside the other span thresholds so there is one of it.
 */
export const MIN_USEFUL_REGION_SEC = 0.5

export interface TargetChipGeom {
  /** File-second where the CLIP'S SAMPLE ZERO sits (the round-7 formalization —
   *  playback always cued clips relative to this). Resolved from the cell's own
   *  start plus target_offset_ms; absolute for legacy takes. */
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
 * Where the clip's sample zero sits, in file seconds.
 *
 * The offset wins; the absolute key is a permanent fallback, not a migration
 * step. It has to stay permanent because rebuild.ts replays historical
 * cell.lane.retime events, so absolute values keep being re-materialized no
 * matter what any one-off backfill did. A legacy take simply doesn't follow its
 * cell until someone next drags it, which is exactly today's behavior — better
 * than a migration that silently MOVES takes it guessed wrong about.
 */
function targetAnchorSec(cell: CellData, section: SpanSec): number {
  // `!= null`, not truthiness: an offset of exactly 0 is legal and common (a
  // take that starts flush with its line), and would otherwise fall through to
  // the legacy branch and then to the section start.
  const offsetMs = metaNumber(cell.metadata, "target_offset_ms")
  if (offsetMs != null) return section.start + offsetMs / 1000
  const absoluteMs = metaNumber(cell.metadata, "target_start_ms")
  if (absoluteMs != null) return absoluteMs / 1000
  return section.start
}

/**
 * The inverse: what to STORE so a chip's sample zero lands at `anchorSec`.
 *
 * Lives here beside the reader so the two can't drift, and so the conversion is
 * unit-testable without a component. Clamped so a chip can never be anchored
 * before file zero — the same invariant the caller used to enforce on the
 * absolute value, restated in the offset domain.
 */
export function targetOffsetMsFor(cell: CellData, anchorSec: number): number {
  const startMs = Math.round((cell.startTime ?? 0) * 1000)
  const floored = Math.max(-startMs, Math.round(anchorSec * 1000) - startMs)
  // A cell starting at 0 clamps to -0, which is only ever confusing downstream.
  return floored === 0 ? 0 : floored
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
  const anchor = targetAnchorSec(cell, section)
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
 * Audible overlap between a chip and its neighbours' chips (null = none).
 * tailSec — how far this chip's END intrudes past the NEXT chip's start.
 * headSec — how much of this chip's HEAD lies under the PREVIOUS chip's tail
 * (reachable since the end-based drag bounds let a chip begin before its own
 * section). Each is the chip's OWN number, so a hover can state exactly how
 * much of it double-sounds — both are clamped to the actual INTERSECTION, so
 * a chip in a degenerate persisted order (starts out of sequence) can never
 * report more overlap than it has length.
 */
export function chipOverlaps(
  span: SpanSec,
  prevChip: SpanSec | null,
  nextChipStartSec: number | null,
): { headSec: number | null; tailSec: number | null } {
  const tailSec =
    nextChipStartSec != null && span.end > nextChipStartSec + OVERLAP_EPS_SEC
      ? span.end - Math.max(span.start, nextChipStartSec)
      : null
  // The prevChip.start < span.end guard: a chip slid entirely BEFORE the
  // previous chip's box does not intersect it — that is not an overlap.
  const headSec =
    prevChip != null && prevChip.end > span.start + OVERLAP_EPS_SEC && prevChip.start < span.end
      ? Math.min(prevChip.end, span.end) - Math.max(span.start, prevChip.start)
      : null
  return { headSec, tailSec }
}

/**
 * How worried the UI should be about a chip: "soft" (amber) when its tail
 * runs meaningfully past its section's end, "overlap" (red) when it collides
 * with a neighbour's chip — both dubs will sound through the overlap.
 *
 * BLAME THE TRESPASSER: a chip goes red only for territory it left its own
 * section to claim — its end past the section's end into the next chip, or
 * its head before the section's start under the previous chip. An in-bounds
 * chip never lights up because a neighbour intruded on it; the intruder
 * carries the warning. (In layouts where no chip starts before its section —
 * everything pre-end-based-drag — this is exactly the round-7 behavior.)
 */
export function chipOverflowState(
  span: SpanSec,
  section: SpanSec,
  prevChip: SpanSec | null,
  nextChipStartSec: number | null,
): "none" | "soft" | "overlap" {
  const t = chipTrespass(span, section, prevChip, nextChipStartSec)
  if (t.head || t.tail) return "overlap"
  if (span.end > section.end + OVERFLOW_SOFT_SEC) return "soft"
  return "none"
}

/**
 * WHICH END of a chip is trespassing — the blame rule above, as booleans.
 * An end counts only when it BOTH left this chip's own section AND actually
 * reaches a neighbour's chip: an in-bounds chip is never blamed for a
 * neighbour intruding on it, and leaving your section over empty space is
 * "soft", not a collision.
 *
 * 2026-08-08: the paint reads this too — the chip drawn short at rest is the
 * one at fault, on the side it offends — so a warning and a shortened chip
 * can never disagree about who is to blame.
 */
export function chipTrespass(
  span: SpanSec,
  section: SpanSec,
  prevChip: SpanSec | null,
  nextChipStartSec: number | null,
): { head: boolean; tail: boolean } {
  const o = chipOverlaps(span, prevChip, nextChipStartSec)
  return {
    head: o.headSec != null && span.start < section.start,
    tail: o.tailSec != null && span.end > section.end,
  }
}
