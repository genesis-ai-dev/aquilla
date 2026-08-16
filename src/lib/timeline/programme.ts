// AQU-646 SUB-53 — the AUDIO-FIRST layout ("the programme").
//
// In dubbing work the translation has to fit inside the original's window, so
// the timeline's x-axis is file seconds and everything is drawn where it
// really sits in the imported recording. In audio-first translation that isn't
// true: a translated verse routinely runs much longer than its original, and
// because the drift accumulates, by the fourth or fifth verse the translation
// you're looking at is sitting under a completely different verse.
//
// This module derives the alternative: every verse gets a SLOT as long as its
// longer side, laid end to end. The two sides of a verse share a left edge, so
// which goes with which is never in doubt, and nothing ever paints over
// anything.
//
//   file clock   |v1  ||v2 ||v3   ||v4 |          (frozen at import)
//   programme    |v1  |    |v2 |   |v3   | |v4 |  <- source, spaced out
//                |v1      ||v2     ||v3   ||v4  | <- target, its real length
//
// NOTHING HERE IS STORED. Slot positions are a pure function of the cells and
// their attachments, so switching modes changes no data, syncs nothing, and
// reproduces the other view exactly. That is deliberate: the source split is
// FROZEN at import (a section's audio IS a window into the one imported file —
// see trimWindowForCell), so spacing the original out could never have been a
// data edit in the first place.

import { activeTargetForCell, sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { effectiveAttachmentDurationMs, MIN_TARGET_LEN_SEC } from "./lane-timing"
import type { CellData } from "@/hooks/useCells"

/** A window on some clock, in seconds. */
export interface Window {
  start: number
  end: number
}

export interface ProgrammeSlot {
  cellId: string
  /** Where this verse begins on the PROGRAMME clock. */
  startSec: number
  /** How long the original SOUNDS. Zero when the section has no source clip
   *  left (a take-only or generated-voice-only verse) — there is nothing to
   *  hear, so it must not reserve any of the verse's length. */
  sourceLenSec: number
  /** The dub's trim-aware length; 0 when the verse has no dub yet. */
  targetLenSec: number
  /** The section's own span — what it was worth before any of this. Used when
   *  a verse has no playable audio at all, and as the width of an
   *  unmeasurable dub. */
  nominalLenSec: number
  /** What the ORIGINAL's card is drawn at: its real audible length, or the
   *  whole verse when there is no original audio to be honest about. */
  cardLenSec: number
  /** max(sourceLenSec, targetLenSec) — the verse's footprint. Every part of it
   *  is covered by audio, which is what lets the clock run without skipping. */
  slotLenSec: number
  /**
   * Which side runs long enough to clock the slot, or null when neither side
   * has playable audio. Playback rides this element and lets the other one
   * stop early (that's the silence Sam asked for on the shorter side).
   */
  clock: "source" | "target" | null
  /** The original's window on the FILE clock; null for a take-only section. */
  sourceWindow: Window | null
  /** The dub's window on its OWN clip clock (trim start → trim end); null
   *  when there's no dub, or when its length simply isn't known. */
  targetWindow: Window | null
}

export interface Programme {
  slots: ProgrammeSlot[]
  /** Total assembled length — what the ruler and the transport show. */
  totalSec: number
  /** cellId → slot, for card clicks and chip geometry. */
  byCellId: Map<string, ProgrammeSlot>
}

const EMPTY: Programme = { slots: [], totalSec: 0, byCellId: new Map() }

function sectionLenSec(cell: CellData): number {
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return 0
  if (typeof endTime !== "number" || !Number.isFinite(endTime)) return 0
  return Math.max(0, endTime - startTime)
}

/**
 * Lay the verses out end to end, each taking as much room as its longer side.
 * `cells` must already be the dialogue lane, time-sorted (deriveLanes does
 * both) — the programme's order IS the cells' order.
 */
export function buildProgramme(cells: readonly CellData[]): Programme {
  if (cells.length === 0) return EMPTY
  const slots: ProgrammeSlot[] = []
  const byCellId = new Map<string, ProgrammeSlot>()
  let cursor = 0

  for (const cell of cells) {
    const nominalLenSec = sectionLenSec(cell)
    // A section with no usable timing has no place in a laid-out programme —
    // it lives in the Untimed strip, exactly as it does in dubbing mode.
    if (nominalLenSec <= 0) continue

    const hasSourceClip = sourceClipAudioForCell(cell) != null
    const sourceWindow: Window | null =
      hasSourceClip && typeof cell.startTime === "number" && typeof cell.endTime === "number"
        ? { start: cell.startTime, end: cell.endTime }
        : null
    // A verse whose source clip is gone (generated-voice-only, or a lone take)
    // has NO original to hear. Letting its section span reserve room anyway
    // would leave a stretch of the verse that nothing can play — and the clock
    // would have to skip it, which is exactly what this design avoids.
    const sourceLenSec = sourceWindow ? nominalLenSec : 0

    const target = activeTargetForCell(cell)
    const att = target ? cell.attachments?.[target.audioId] : undefined
    const effMs = effectiveAttachmentDurationMs(att)
    // A dub whose length genuinely isn't known borrows the section's, which is
    // what its chip already draws at (targetChipGeom's `usingFallback`). It
    // gets no playback window — there's no honest trim to play.
    const targetLenSec = target ? (effMs != null ? effMs / 1000 : nominalLenSec) : 0
    const trimStartSec =
      att?.trimStartMs != null && Number.isFinite(att.trimStartMs) && att.trimStartMs > 0
        ? att.trimStartMs / 1000
        : 0
    const targetWindow: Window | null =
      target && effMs != null ? { start: trimStartSec, end: trimStartSec + effMs / 1000 } : null

    const audibleLenSec = Math.max(sourceLenSec, targetLenSec)
    // Nothing playable at all: keep the section's own length so its card is
    // still readable. Playback skips such a verse outright.
    const slotLenSec = audibleLenSec > 0 ? audibleLenSec : Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
    const clock: ProgrammeSlot["clock"] =
      sourceWindow && targetWindow
        ? targetLenSec > sourceLenSec
          ? "target"
          : "source"
        : sourceWindow
          ? "source"
          : targetWindow
            ? "target"
            : null

    const slot: ProgrammeSlot = {
      cellId: cell.id,
      startSec: cursor,
      sourceLenSec,
      targetLenSec,
      nominalLenSec,
      cardLenSec: sourceLenSec > 0 ? sourceLenSec : slotLenSec,
      slotLenSec,
      clock,
      sourceWindow,
      targetWindow,
    }
    slots.push(slot)
    byCellId.set(cell.id, slot)
    cursor += slotLenSec
  }

  return { slots, totalSec: cursor, byCellId }
}

/** The slot a programme second falls in. Times past the end return null. */
export function slotAtProgrammeSec(prog: Programme, sec: number): ProgrammeSlot | null {
  if (!Number.isFinite(sec) || sec < 0) return null
  // Binary search — a long file can carry thousands of verses and playback
  // asks this ~4×/second.
  let lo = 0
  let hi = prog.slots.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = prog.slots[mid]
    if (sec < s.startSec) hi = mid - 1
    else if (sec >= s.startSec + s.slotLenSec) lo = mid + 1
    else return s
  }
  return null
}

export function slotForCell(prog: Programme, cellId: string): ProgrammeSlot | null {
  return prog.byCellId.get(cellId) ?? null
}

/** The index of a slot in the programme, or -1. */
export function slotIndex(prog: Programme, cellId: string): number {
  return prog.slots.findIndex((s) => s.cellId === cellId)
}

export interface SidePosition {
  slot: ProgrammeSlot
  /** Seconds into that side's own clip. */
  clipSec: number
}

/**
 * Where the ORIGINAL should be playing at programme second `sec` — a position
 * on the FILE clock. Null once the original has run out inside its slot: that
 * is the silence the shorter side plays while the longer one finishes.
 */
export function programmeToSource(prog: Programme, sec: number): SidePosition | null {
  const slot = slotAtProgrammeSec(prog, sec)
  if (!slot?.sourceWindow) return null
  const into = sec - slot.startSec
  if (into >= slot.sourceLenSec) return null
  return { slot, clipSec: slot.sourceWindow.start + into }
}

/** The same for the TRANSLATION — a position on the dub clip's own clock. */
export function programmeToTarget(prog: Programme, sec: number): SidePosition | null {
  const slot = slotAtProgrammeSec(prog, sec)
  if (!slot?.targetWindow) return null
  const into = sec - slot.startSec
  if (into >= slot.targetLenSec) return null
  return { slot, clipSec: slot.targetWindow.start + into }
}

/**
 * The inverse for the original: a file second → where it now sits on the
 * programme clock. Used by the text→media trace and by anything that still
 * thinks in file seconds. Null when no verse owns that moment of the file.
 */
export function sourceFileSecToProgramme(prog: Programme, fileSec: number): number | null {
  if (!Number.isFinite(fileSec)) return null
  for (const slot of prog.slots) {
    const w = slot.sourceWindow
    if (!w) continue
    if (fileSec >= w.start && fileSec < w.end) return slot.startSec + (fileSec - w.start)
  }
  return null
}

/** Where a verse begins on the programme clock — card and chip clicks seek here. */
export function cellStartProgrammeSec(prog: Programme, cellId: string): number | null {
  return prog.byCellId.get(cellId)?.startSec ?? null
}

/**
 * Move a span expressed on the FILE clock onto the programme clock. Used for
 * the odd card that isn't itself a verse — a real subtitle cell in a mixed
 * file, which carries its own timing against the imported recording.
 *
 * The mapping is piecewise (each verse's original keeps its length but moves),
 * so an edge that lands in one of the silences between originals is snapped to
 * the nearest verse boundary rather than invented. Null when the span doesn't
 * touch any verse at all.
 */
export function fileSpanToProgrammeSpan(
  prog: Programme,
  startSec: number,
  endSec: number,
): { start: number; end: number } | null {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
  const direct = sourceFileSecToProgramme(prog, startSec)
  // The start fell in a silence (or before the first verse): take the first
  // verse that begins at or after it.
  const start =
    direct ??
    prog.slots.find((s) => s.sourceWindow && s.sourceWindow.start >= startSec)?.startSec ??
    null
  if (start == null) return null
  const directEnd = sourceFileSecToProgramme(prog, endSec)
  // Same on the way out — the last verse that has finished by then.
  let end = directEnd
  if (end == null) {
    for (const s of prog.slots) {
      if (s.sourceWindow && s.sourceWindow.end <= endSec) end = s.startSec + s.sourceLenSec
    }
  }
  if (end == null || end <= start) return { start, end: start + Math.max(0.2, endSec - startSec) }
  return { start, end }
}

/**
 * How the translation compares to the original, e.g. 1.8 for "nearly twice as
 * long". Null when either side has no length to compare. Audio-first replaces
 * the amber/red overflow warnings with this — running long is the expected
 * outcome here, not a defect.
 */
export function targetRatio(slot: ProgrammeSlot): number | null {
  if (slot.targetLenSec <= 0 || slot.sourceLenSec <= 0) return null
  return slot.targetLenSec / slot.sourceLenSec
}
