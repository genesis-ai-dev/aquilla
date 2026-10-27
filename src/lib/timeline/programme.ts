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

import { resolveTargetPieces, sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { hasTiming, sortByLens } from "./derive"
import { effectiveAttachmentDurationMs, MIN_TARGET_LEN_SEC, targetChipGeom } from "./lane-timing"
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
  /** The verse's footprint: targetLeadSec + targetLenSec when it has a take
   *  of known length (AQU-2204: only the recordings set it), else its
   *  stand-in or its own span. */
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
   *  when there's no dub, or when its length simply isn't known. For a SPLIT
   *  take it is the window on the JOINED copy's clock: 0 → every piece. */
  targetWindow: Window | null
  /**
   * AQU-1767 (Sam, 2026-10-15): a split take's pieces, in the order they sit
   * in the recording, each as its window on the recording's clock. Free
   * timing plays them as one take — joined into one copy, so nothing has to
   * skip between them — and lays them out end to end. Absent for a take
   * never split.
   */
  targetPieces?: { audioId: string; start: number; end: number }[]
  /**
   * AQU-2204: the line has no times of its own and no recording, so its
   * length is a STAND-IN from its text (lib/timeline/stand-in). It is drawn
   * dashed with no time on it, and playback steps over it (nothing to play).
   * Absent on every other slot.
   */
  standIn?: true
  /**
   * AQU-2204 (Sam, Oct 26): a PAUSE someone left before the take — the take
   * was placed (or recorded) that far after its line's start. Following the
   * recordings keeps it inside the line: the take starts this long into the
   * slot, the slot is that much longer, and the timeline draws the pause
   * lightly. Absent when the take starts on its line (or before it).
   */
  targetLeadSec?: number
}

/** A pause shorter than this is a placement wobble, not a pause. */
export const MIN_TARGET_LEAD_SEC = 0.05

export interface BuildProgrammeOptions {
  /**
   * AQU-2204: the stand-in length of a line with NO TIMES. When given, such a
   * line takes its place in the programme (its recording's length once it has
   * one, else this) instead of being left out.
   */
  standInLenSec?(cell: CellData): number
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
 * A split take's pieces as windows on the recording's clock, in clip order,
 * and how long they sound together. Null when any piece's length is unknown.
 */
function splitWindows(
  cell: CellData,
  pieces: readonly { audioId: string }[],
): { pieces: { audioId: string; start: number; end: number }[]; totalMs: number } | null {
  const out: { audioId: string; start: number; end: number }[] = []
  let totalMs = 0
  for (const p of pieces) {
    const att = cell.attachments?.[p.audioId]
    const ms = effectiveAttachmentDurationMs(att)
    if (ms == null || !att) return null
    const start = att.trimStartMs != null && Number.isFinite(att.trimStartMs) && att.trimStartMs > 0 ? att.trimStartMs / 1000 : 0
    out.push({ audioId: p.audioId, start, end: start + ms / 1000 })
    totalMs += ms
  }
  return { pieces: out, totalMs }
}

/**
 * Lay the verses out end to end, each taking as much room as its longer side.
 * `cells` must already be the dialogue lane, time-sorted (deriveLanes does
 * both) — the programme's order IS the cells' order.
 */
export function buildProgramme(cells: readonly CellData[], opts?: BuildProgrammeOptions): Programme {
  if (cells.length === 0) return EMPTY
  const slots: ProgrammeSlot[] = []
  const byCellId = new Map<string, ProgrammeSlot>()
  let cursor = 0

  for (const cell of cells) {
    let nominalLenSec = sectionLenSec(cell)
    // A section with no usable timing has no place in a laid-out programme —
    // it lives in the Untimed strip, exactly as it does in dubbing mode.
    // AQU-2204: unless the caller gives it a stand-in length (a file with no
    // times at all, following its recordings), in which case it takes room.
    const untimed = nominalLenSec <= 0
    if (untimed) {
      if (!opts?.standInLenSec) continue
      nominalLenSec = Math.max(MIN_TARGET_LEN_SEC, opts.standInLenSec(cell))
    }

    // An untimed line has no window into any source recording to play.
    const hasSourceClip = !untimed && sourceClipAudioForCell(cell) != null
    const fullSourceStart = hasSourceClip && typeof cell.startTime === "number" && typeof cell.endTime === "number"
      ? cell.startTime
      : null

    const pieces = resolveTargetPieces(cell)
    const target = pieces[0] ?? null
    const att = target ? cell.attachments?.[target.audioId] : undefined
    // AQU-1767: a split take sounds as all its pieces, back to back — but only
    // when every piece's length is known; otherwise its first piece, as before.
    const split = pieces.length > 1 ? splitWindows(cell, pieces) : null
    const effMs = split ? split.totalMs : effectiveAttachmentDurationMs(att)
    // A dub whose length genuinely isn't known borrows the section's, which is
    // what its chip already draws at (targetChipGeom's `usingFallback`). It
    // gets no playback window — there's no honest trim to play.
    const targetLenSec = target ? (effMs != null ? effMs / 1000 : nominalLenSec) : 0
    const trimStartSec =
      !split && att?.trimStartMs != null && Number.isFinite(att.trimStartMs) && att.trimStartMs > 0
        ? att.trimStartMs / 1000
        : 0
    const targetWindow: Window | null =
      target && effMs != null ? { start: trimStartSec, end: trimStartSec + effMs / 1000 } : null

    // AQU-2204: a pause someone left before the take stays inside its line.
    // It is where the take was PLACED (its clip's start against the line's),
    // never a head trim, which only removes the start of the recording. Only a
    // whole take with a known length on a line with times can carry one — a
    // split take's pieces sit end to end from the slot's start.
    const leadGeom = !untimed && targetWindow && !split ? targetChipGeom(cell, att) : null
    const rawLeadSec = leadGeom && typeof cell.startTime === "number" ? leadGeom.anchor - cell.startTime : 0
    const targetLeadSec = rawLeadSec >= MIN_TARGET_LEAD_SEC ? rawLeadSec : 0
    // AQU-2204 (Sam, Oct 27): FOLLOWING THE RECORDINGS, ONLY THE RECORDINGS
    // SET A LINE'S LENGTH. Today's Free timing followed both (each line the
    // longer of its source and its take); the source no longer has a say:
    //   - a line with a take lasts the pause someone left before it plus the take;
    //   - a take whose length isn't known yet keeps the line's own span, which
    //     its chip already borrows;
    //   - a line with no take lasts its stand-in length, from its words (the
    //     caller's estimator), else its own span;
    // and the source sounds only as long as the line lasts: cut where it ends.
    const recordedLenSec = targetWindow ? targetLeadSec + targetLenSec : 0
    const usesStandIn = !target && (untimed || Boolean(opts?.standInLenSec))
    const unrecordedLenSec = untimed
      ? nominalLenSec
      : opts?.standInLenSec
        ? Math.max(MIN_TARGET_LEN_SEC, opts.standInLenSec(cell))
        : Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
    const slotLenSec = recordedLenSec > 0
      ? recordedLenSec
      : target
        ? Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
        : unrecordedLenSec
    // A verse whose source clip is gone (generated-voice-only, or a lone take)
    // has NO original to hear; one that runs past the line is cut at its end.
    const sourceLenSec = fullSourceStart != null ? Math.min(nominalLenSec, slotLenSec) : 0
    const sourceWindow: Window | null =
      fullSourceStart != null ? { start: fullSourceStart, end: fullSourceStart + sourceLenSec } : null
    // The take clocks its line (the source never outlasts it now); a line with
    // no take is clocked by its source, else nothing plays and playback steps
    // over it.
    const clock: ProgrammeSlot["clock"] = targetWindow ? "target" : sourceWindow ? "source" : null

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
      ...(split ? { targetPieces: split.pieces } : {}),
      ...(usesStandIn ? { standIn: true as const } : {}),
      ...(targetLeadSec > 0 ? { targetLeadSec } : {}),
    }
    slots.push(slot)
    byCellId.set(cell.id, slot)
    cursor += slotLenSec
  }

  return { slots, totalSec: cursor, byCellId }
}

/**
 * AQU-2204: the lines a file's programme is laid out from, in its order — the
 * ONE answer the timeline and the transport share, so the drawing and the
 * playback can never disagree about where a line is:
 *   - the timed media cells (an mp3 import, a source recording cut into lines);
 *   - else the timed cells (AQU-1704: a video-less subtitle import's cues);
 *   - else, for a file with NO times at all (an audio Bible book), every line in
 *     its own order, each laid out at its recording's length or a stand-in.
 * `untimed` says which of the last applies: the caller then passes the stand-in
 * estimator to `buildProgramme`.
 */
export function programmeLines(cells: readonly CellData[]): { lines: CellData[]; untimed: boolean } {
  const media = cells.filter((c) => (c.medium ?? "text") === "media" && hasTiming(c))
  if (media.length > 0) return { lines: sortByLens(media, "time"), untimed: false }
  const timed = cells.filter((c) => hasTiming(c))
  if (timed.length > 0) return { lines: sortByLens(timed, "time"), untimed: false }
  return { lines: sortByLens(cells, "sequence"), untimed: cells.length > 0 }
}

/**
 * Sam's decision (hidden lines on the timeline): the programme as it PLAYS
 * when some lines are hidden. Every verse keeps its place and length — the
 * timeline draws a hidden one where it always sat, faded — but a hidden
 * verse's take is taken out: it sounds only its original, clocked by it, and
 * one with no original has nothing left to play, so playback steps over it.
 */
export function withoutHiddenTakes(prog: Programme, hiddenCellIds: ReadonlySet<string>): Programme {
  if (hiddenCellIds.size === 0) return prog
  const byCellId = new Map<string, ProgrammeSlot>()
  const slots = prog.slots.map((slot) => {
    const out: ProgrammeSlot = hiddenCellIds.has(slot.cellId)
      ? { ...slot, targetWindow: null, targetPieces: undefined, clock: slot.sourceWindow ? "source" : null }
      : slot
    byCellId.set(out.cellId, out)
    return out
  })
  return { ...prog, slots, byCellId }
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
