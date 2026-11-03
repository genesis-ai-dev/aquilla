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
import { isHiddenCell } from "@/lib/cells/hidden"
import { standInEstimator } from "./stand-in"
import { isDefaultTrackSlot } from "./track-slots"

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
  targetPieces?: ProgrammePiece[]
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
  /**
   * AQU-2252: the line's takes on every track but the Language lane's main
   * one, piece by piece. Absent when it has none. See `ProgrammeLayer`.
   */
  layers?: ProgrammeLayer[]
}

/**
 * AQU-2252: a take (or a piece of one) on an added track, following the
 * recordings. It keeps its own length and its own trim, moves with its line,
 * and plays on its own from its own start. What its track is decides the rest
 * (Sam, Oct 29):
 *
 *   - A track that SETS LINE LENGTHS — every track, by default: a new track is
 *     most often another voice. Its take sits in its line exactly as the main
 *     take does — after the pause someone left before it (where its clip's
 *     start was placed), never before the line's start — and its line grows
 *     to hold it: a line lasts as long as its longest take on any such track.
 *     So it never runs past its line.
 *
 *   - A track made a LAYER — music, sound effects, ambience. It sets nothing.
 *     It sits against its line the way a take does following the source: its
 *     clip's sample zero at its own stored offset from the line's start, so its
 *     sound starts a head trim later (a head trim moves only its left edge, like
 *     a region in a DAW); it may start a little before its line (a lead-in) and
 *     run on past it, over the lines after it, and the timeline warns about
 *     that as it does following the source. It never sounds before the start
 *     of the file: a place that would is drawn and played from there instead.
 */
export interface ProgrammeLayer {
  /** The track it is on — that track's storage slot. */
  slot: string
  audioId: string
  /** Where it starts SOUNDING, in seconds from its line's start. Never < 0 on
   *  a track that sets line lengths; a layer's may be (its lead-in). */
  atSec: number
  /** Where its clip's sample zero sits, from its line's start: `atSec` less
   *  its head trim. */
  anchorSec: number
  /** Its window on its own clip's clock (head trim → tail trim); null when its
   *  length isn't known, which leaves it nothing honest to play. */
  window: Window | null
  /** Its track sets its lines' lengths (the default), so it sits inside its
   *  line like the main take; false on a track made a layer. */
  setsLength: boolean
}

/**
 * AQU-1767 / AQU-1758: one piece of a split take — its window on the
 * recording's clock, where it sits in the line's slot (`atSec`, from the
 * slot's start), and the silence left before it after the piece in front
 * (`gapBeforeSec`, absent when they touch). The silence is someone's: a piece
 * dragged away from the one before it (Sam: deliberate silence, which belongs
 * to the line and plays as silence).
 *
 * A piece's place means one thing, the thing following the source reads:
 * where its clip's start sits from its line's start (AQU-2267: each timing
 * keeps its own such place — see `pauseAskedSec`). A cut leaves every piece
 * the take's place, so following the recordings each piece is read from where
 * it would sit if the take played straight through, its pieces end to end —
 * `pieceAtSec`. A piece moved some distance in either timing is that distance
 * along in both.
 */
export interface ProgrammePiece {
  audioId: string
  start: number
  end: number
  atSec: number
  gapBeforeSec?: number
}

/** A pause shorter than this is a placement wobble, not a pause. */
export const MIN_TARGET_LEAD_SEC = 0.05

/**
 * AQU-2204 / AQU-1758: the pause a take (or a piece of one) asks for before
 * it, measured from its line's start — the stored placement (`targetOffsetMs`,
 * through the anchor rungs on a timed line). On a line with NO times there is
 * no line start to measure from, so the take's own offset is read as the
 * pause from the start of its slot (Sam's decision 3). Zero when nobody
 * placed it.
 *
 * AQU-2267 (Sam, Oct 29): A TAKE HAS A PLACE IN EACH TIMING. Its place here,
 * following the recordings, is `recordingsOffsetMs` — the same measure, where
 * its clip's start was put from its line's start — and a move adds the same
 * distance to both places, each held by its own timing's limits
 * (lib/timeline/take-place). A take with no place of its own here (every take
 * before AQU-2267, and any nobody has moved since) reads its place following
 * the source, exactly as it always did.
 *
 * WHAT A HEAD TRIM DOES (settled by AQU-2252, kept here on purpose). The place
 * is where the CLIP'S START sits, never where its sound starts:
 *   - On the main track and a track that sets line lengths (a voice), following
 *     the recordings, the take sounds from its place: the trimmed-off head is
 *     simply not there. So a head trim TIGHTENS the line — the sound comes
 *     earlier and the pause before it is unchanged. People trim leading
 *     silence to tighten a read.
 *   - On a track made a layer, and everywhere following the source
 *     (`targetChipGeom`), the clip's start stays at its place and the sound
 *     starts a head trim later: a head trim moves only the take's left edge,
 *     and the sound stays where it was, like a region in a DAW.
 * A piece of a split take on the main track or a voice track (AQU-1758): its
 * place is its clip's start too, and following the recordings it sounds that
 * far along from where the take, played straight through, would put it —
 * after the pieces in front of it (`pieceAtSec`).
 */
function pauseAskedSec(cell: CellData, att: NonNullable<CellData["attachments"]>[string] | undefined, untimed: boolean): number {
  // `!= null`-style: 0 is a real place (the line's own start), never "none".
  const placedHere = att?.recordingsOffsetMs
  if (typeof placedHere === "number" && Number.isFinite(placedHere)) return placedHere / 1000
  if (untimed) {
    const ms = att?.targetOffsetMs
    return typeof ms === "number" && Number.isFinite(ms) ? ms / 1000 : 0
  }
  const geom = targetChipGeom(cell, att)
  return geom && typeof cell.startTime === "number" ? geom.anchor - cell.startTime : 0
}

/**
 * AQU-1758: where a piece of a split take sits in its line's slot following
 * the recordings, from its place (`pauseAskedSec`) and how long the pieces
 * before it sound (`heardBeforeSec`): never over the piece in front, which
 * ends at `floorSec` (0 for the first piece). Following the source the same
 * place puts the piece where its sound is in the take; here the parts of the
 * take nobody hears are left out — its head trim and anything cut away between
 * the pieces — so its untouched pieces sit end to end.
 */
function pieceAtSec(askedSec: number, heardBeforeSec: number, floorSec: number): number {
  const at = askedSec + heardBeforeSec
  return at - floorSec >= MIN_TARGET_LEAD_SEC ? at : floorSec
}

export interface BuildProgrammeOptions {
  /**
   * AQU-2204: the stand-in length of a line with NO TIMES. When given, such a
   * line takes its place in the programme (its recording's length once it has
   * one, else this) instead of being left out.
   */
  standInLenSec?(cell: CellData): number
  /**
   * AQU-2252: which added tracks' takes are laid in — their slots. The
   * transport passes the file's tracks, the ones it plays, and so does the
   * timeline, so the two agree about every line's length. Absent, every added
   * track a line has a take on.
   */
  layerSlots?: readonly string[]
  /**
   * AQU-2252 (Sam, Oct 29): the added tracks made LAYERS — music, sound
   * effects, ambience: their takes set no line's length (see
   * `ProgrammeLayer`). Every other track's takes set their lines' lengths,
   * which is the default; absent, none is a layer.
   */
  layerTrackSlots?: readonly string[]
}

function trimStartSecOf(att: { trimStartMs?: number } | undefined): number {
  return att?.trimStartMs != null && Number.isFinite(att.trimStartMs) && att.trimStartMs > 0 ? att.trimStartMs / 1000 : 0
}

/**
 * A line's take on one track, placed the way FOLLOWING THE RECORDINGS places
 * the main take: its pause before it (where its clip's start was put, never a
 * head trim), its length, and for a split take each piece where it was put,
 * never over the piece in front. `slot` absent is the main track.
 */
interface PlacedTake {
  /** The take's first piece; null when the line has no take on this track. */
  target: { audioId: string } | null
  /** Each piece of a split take, placed; null for a take never split. */
  pieces: ProgrammePiece[] | null
  /** How long it sounds (every piece, and the silence between them); null
   *  when its length isn't known. */
  lenSec: number | null
  /** Its window on its own clip's clock (a split take's: on its joined copy's,
   *  0 → every piece); null when its length isn't known. */
  window: Window | null
  /** The pause before it, inside its line (0 when none worth keeping). */
  leadSec: number
}

function placeTake(cell: CellData, untimed: boolean, slot?: string): PlacedTake {
  const refs = resolveTargetPieces(cell, slot)
  const target = refs[0] ?? null
  const att = target ? cell.attachments?.[target.audioId] : undefined
  // AQU-1767: a split take sounds as all its pieces, back to back — but only
  // when every piece's length is known; otherwise its first piece, as before.
  // AQU-1758 (Sam's decision 3): each piece sits where it was placed, never
  // over the one before it; a gap someone dragged open between two pieces is
  // deliberate silence inside the line, joined into the copy as silence.
  const split = refs.length > 1 ? splitWindows(cell, refs) : null
  let pieces: ProgrammePiece[] | null = null
  let splitLeadSec = 0
  let splitSpanMs = 0
  if (split) {
    let prevEnd = 0
    let heard = 0
    pieces = split.pieces.map((p, i) => {
      const floor = i === 0 ? 0 : prevEnd
      const atSec = pieceAtSec(pauseAskedSec(cell, cell.attachments?.[p.audioId], untimed), heard, floor)
      const gap = atSec - floor
      prevEnd = atSec + (p.end - p.start)
      heard += p.end - p.start
      return { ...p, atSec, ...(i > 0 && gap > 0 ? { gapBeforeSec: gap } : {}) }
    })
    splitLeadSec = pieces[0].atSec
    splitSpanMs = (prevEnd - splitLeadSec) * 1000
  }
  const effMs = split ? splitSpanMs : effectiveAttachmentDurationMs(att)
  const trimStartSec = split ? 0 : trimStartSecOf(att)
  const window: Window | null = target && effMs != null ? { start: trimStartSec, end: trimStartSec + effMs / 1000 } : null
  // AQU-2204: a pause someone left before the take stays inside its line.
  // It is where the take was PLACED (its clip's start against the line's),
  // never a head trim, which only removes the start of the recording. Only a
  // take with a known length can carry one. AQU-1758: on a line with no
  // times too (measured from the slot's start), and a split take's first
  // piece carries the take's.
  const rawLeadSec = !window ? 0 : split ? splitLeadSec : pauseAskedSec(cell, att, untimed)
  return {
    target,
    pieces,
    lenSec: target && effMs != null ? effMs / 1000 : null,
    window,
    leadSec: rawLeadSec >= MIN_TARGET_LEAD_SEC ? rawLeadSec : 0,
  }
}

/** AQU-2252: a take on an added track that sets its line's length, piece by
 *  piece, placed as `placeTake` placed it (see `ProgrammeLayer`). */
function lengthSettingLayers(slot: string, cell: CellData, placed: PlacedTake): ProgrammeLayer[] {
  if (!placed.target) return []
  if (placed.pieces) {
    return placed.pieces.map((p) => ({
      slot, audioId: p.audioId, atSec: p.atSec, anchorSec: p.atSec - p.start,
      window: { start: p.start, end: p.end }, setsLength: true,
    }))
  }
  const trimStartSec = trimStartSecOf(cell.attachments?.[placed.target.audioId])
  return [{
    slot,
    audioId: placed.target.audioId,
    atSec: placed.leadSec,
    anchorSec: placed.leadSec - trimStartSec,
    window: placed.window,
    setsLength: true,
  }]
}

/** AQU-2252: a take on a track made a LAYER — every piece of it, each placed on
 *  its own the way a take is placed following the source (see `ProgrammeLayer`).
 *  `lineStartSec` is where its line starts on the programme clock: nothing
 *  sounds before the file's start. */
function layerTrackLayers(slot: string, cell: CellData, untimed: boolean, lineStartSec: number): ProgrammeLayer[] {
  const out: ProgrammeLayer[] = []
  for (const piece of resolveTargetPieces(cell, slot)) {
    const att = cell.attachments?.[piece.audioId]
    const trimStartSec = trimStartSecOf(att)
    // The stored place is the clip's sample zero, from the line's start.
    const atSec = Math.max(-lineStartSec, pauseAskedSec(cell, att, untimed) + trimStartSec)
    const effMs = effectiveAttachmentDurationMs(att)
    out.push({
      slot,
      audioId: piece.audioId,
      atSec,
      anchorSec: atSec - trimStartSec,
      window: effMs != null ? { start: trimStartSec, end: trimStartSec + effMs / 1000 } : null,
      setsLength: false,
    })
  }
  return out
}

/**
 * AQU-2252: whether anything of the line's own sounds in it — its original,
 * its take on the main track, or a take on any other track. A line with none
 * of these has nothing to play of its own (a layer running on over it from the
 * line before is not its own).
 */
export function slotHasOwnSound(slot: ProgrammeSlot): boolean {
  return Boolean(slot.sourceWindow || slot.targetWindow || slot.layers?.some((l) => l.window))
}

export interface Programme {
  slots: ProgrammeSlot[]
  /** Total assembled length — what the ruler and the transport show. AQU-2252:
   *  it reaches the end of a layer that runs on past the last line, which
   *  plays out to its end. */
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
/** AQU-2252: where a line's last take on another track stops sounding, on the
 *  programme clock (0 with none) — what the file's length reaches to. */
function layersReachSec(lineStartSec: number, layers: readonly ProgrammeLayer[] | undefined): number {
  let reach = 0
  for (const l of layers ?? []) {
    if (l.window) reach = Math.max(reach, lineStartSec + l.atSec + (l.window.end - l.window.start))
  }
  return reach
}

export function buildProgramme(cells: readonly CellData[], opts?: BuildProgrammeOptions): Programme {
  if (cells.length === 0) return EMPTY
  const slots: ProgrammeSlot[] = []
  const byCellId = new Map<string, ProgrammeSlot>()
  let cursor = 0
  // AQU-2252: how far the furthest take on another track reaches — a layer
  // may run on past the last line, and the file plays it out to its end.
  let reachSec = 0

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

    // The main track's take, and AQU-2252 the line's takes on its other
    // tracks: each on a track that sets line lengths placed as the main take
    // is, each on a track made a layer placed against the line.
    const main = placeTake(cell, untimed)
    const target = main.target
    const placedPieces = main.pieces
    // A dub whose length genuinely isn't known borrows the section's, which is
    // what its chip already draws at (targetChipGeom's `usingFallback`). It
    // gets no playback window — there's no honest trim to play.
    const targetLenSec = target ? (main.lenSec ?? nominalLenSec) : 0
    const targetWindow = main.window
    const targetLeadSec = main.leadSec
    const layerTracks = new Set(opts?.layerTrackSlots ?? [])
    const extraSlots = [...new Set(opts?.layerSlots ?? Object.keys(cell.selectedBySlot ?? {}))]
      .filter((slot) => !isDefaultTrackSlot(slot))
    const lengthTakes: PlacedTake[] = target ? [main] : []
    const layers: ProgrammeLayer[] = []
    for (const slot of extraSlots) {
      if (layerTracks.has(slot)) continue
      const placed = placeTake(cell, untimed, slot)
      if (!placed.target) continue
      lengthTakes.push(placed)
      layers.push(...lengthSettingLayers(slot, cell, placed))
    }
    // AQU-2204 (Sam, Oct 27): FOLLOWING THE RECORDINGS, ONLY THE RECORDINGS
    // SET A LINE'S LENGTH. Today's Free timing followed both (each line the
    // longer of its source and its take); the source no longer has a say:
    //   - a line with a take lasts the pause someone left before it plus the take;
    //   - a take whose length isn't known yet keeps the line's own span, which
    //     its chip already borrows;
    //   - a line with no take lasts its stand-in length, from its words (the
    //     caller's estimator), else its own span;
    // and the source sounds only as long as the line lasts: cut where it ends.
    // AQU-2252 (Sam, Oct 29): …a take on ANY track that sets line lengths,
    // each at its own place and length: the line lasts as long as the longest
    // of them, so two voices speaking over each other on two tracks both fit.
    // A take on a track made a layer sets nothing.
    let recordedLenSec = 0
    for (const take of lengthTakes) {
      if (take.window && take.lenSec != null) recordedLenSec = Math.max(recordedLenSec, take.leadSec + take.lenSec)
    }
    const recorded = lengthTakes.length > 0
    const usesStandIn = !recorded && (untimed || Boolean(opts?.standInLenSec))
    const unrecordedLenSec = untimed
      ? nominalLenSec
      : opts?.standInLenSec
        ? Math.max(MIN_TARGET_LEN_SEC, opts.standInLenSec(cell))
        : Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
    const slotLenSec = recordedLenSec > 0
      ? recordedLenSec
      : recorded
        ? Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
        : unrecordedLenSec
    // A verse whose source clip is gone (generated-voice-only, or a lone take)
    // has NO original to hear; one that runs past the line is cut at its end.
    const sourceLenSec = fullSourceStart != null ? Math.min(nominalLenSec, slotLenSec) : 0
    const sourceWindow: Window | null =
      fullSourceStart != null ? { start: fullSourceStart, end: fullSourceStart + sourceLenSec } : null
    // The take clocks its line (the source never outlasts it now); a line with
    // no take is clocked by its source, else nothing plays and playback steps
    // over it. AQU-2252: a take on another track never clocks its line — the
    // transport holds the line around it.
    const clock: ProgrammeSlot["clock"] = targetWindow ? "target" : sourceWindow ? "source" : null
    // AQU-2252: the takes on the tracks made layers, placed against the line.
    for (const slot of extraSlots) {
      if (layerTracks.has(slot)) layers.push(...layerTrackLayers(slot, cell, untimed, cursor))
    }
    reachSec = Math.max(reachSec, layersReachSec(cursor, layers))

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
      ...(placedPieces ? { targetPieces: placedPieces } : {}),
      ...(usesStandIn ? { standIn: true as const } : {}),
      ...(targetLeadSec > 0 ? { targetLeadSec } : {}),
      ...(layers.length > 0 ? { layers } : {}),
    }
    slots.push(slot)
    byCellId.set(cell.id, slot)
    cursor += slotLenSec
  }

  return { slots, totalSec: Math.max(cursor, reachSec), byCellId }
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
 * AQU-1758: a file's lines laid out end to end — `programmeLines`, then
 * `buildProgramme` with the stand-in estimator (AQU-2204: following the
 * recordings, every unrecorded line takes its stand-in, timed file or not).
 * The ONE composition the timeline draws, the transport plays, the Timing
 * control measures and the bottom strip shows before anything plays, so none
 * of them can count a different length.
 */
export function layOutProgramme(
  cells: readonly CellData[],
  /** AQU-2252: which added tracks are laid in, and which of them are layers
   *  (see BuildProgrammeOptions). */
  opts?: Pick<BuildProgrammeOptions, "layerSlots" | "layerTrackSlots">,
): { programme: Programme; lines: CellData[]; untimed: boolean } {
  const { lines, untimed } = programmeLines(cells)
  return { programme: buildProgramme(lines, { standInLenSec: standInEstimator(lines), ...opts }), lines, untimed }
}

/**
 * Sam's decision (hidden lines on the timeline): the programme as it PLAYS
 * when some lines are hidden. Every verse keeps its place and length — the
 * timeline draws a hidden one where it always sat, faded — but a hidden
 * verse's take is taken out: it sounds only its original, clocked by it, and
 * one with no original has nothing left to play, so playback steps over it.
 * AQU-2252: its takes on the other tracks (its layers) go with it.
 */
export function withoutHiddenTakes(prog: Programme, hiddenCellIds: ReadonlySet<string>): Programme {
  if (hiddenCellIds.size === 0) return prog
  const byCellId = new Map<string, ProgrammeSlot>()
  const slots = prog.slots.map((slot) => {
    const out: ProgrammeSlot = hiddenCellIds.has(slot.cellId)
      ? { ...slot, targetWindow: null, targetPieces: undefined, layers: undefined, clock: slot.sourceWindow ? "source" : null }
      : slot
    byCellId.set(out.cellId, out)
    return out
  })
  // …and so does how far past the last line they reached: a hidden last
  // line's layer that ran on would leave seconds on the play strip that can
  // never play.
  const totalSec = slots.reduce((t, s) => Math.max(t, s.startSec + s.slotLenSec, layersReachSec(s.startSec, s.layers)), 0)
  return { ...prog, slots, byCellId, totalSec }
}

/**
 * The programme as the queue PLAYS it (play-queue's `progRebuild`): the
 * layout, with the hidden lines' takes taken out. Null where a file with no
 * times has a take whose length was never measured (a generated voice nobody
 * has played yet): such a file only reaches the programme through AQU-2204's
 * stand-ins, so it keeps the plain line-by-line path rather than going quiet.
 *
 * AQU-2252: laid out with the file's added tracks, as the queue is handed
 * them, and saying which lines a take on another track sounds in.
 */
export function playedProgramme(
  cells: readonly CellData[],
  tracks?: Pick<BuildProgrammeOptions, "layerSlots" | "layerTrackSlots">,
): { programme: Programme; hiddenCellIds: ReadonlySet<string>; underLayers: ReadonlySet<string> } | null {
  const { programme: built, lines, untimed } = layOutProgramme(cells, tracks)
  if (untimed && built.slots.some((slot) => slot.targetLenSec > 0 && slot.targetWindow == null)) return null
  const hiddenCellIds = new Set(lines.filter(isHiddenCell).map((c) => c.id))
  const programme = withoutHiddenTakes(built, hiddenCellIds)
  return { programme, hiddenCellIds, underLayers: linesUnderLayers(programme) }
}

/**
 * AQU-2252: the lines a take on another track sounds in — its own line's, or
 * one running on over the lines after it. Following the recordings such a
 * line is held under it (the queue's `progSlotHolds`), so it has something
 * to hear even with nothing of its own.
 */
export function linesUnderLayers(prog: Programme): ReadonlySet<string> {
  const spans: { start: number; end: number }[] = []
  for (const slot of prog.slots) {
    for (const l of slot.layers ?? []) {
      if (!l.window) continue
      const start = slot.startSec + l.atSec
      spans.push({ start, end: start + (l.window.end - l.window.start) })
    }
  }
  const out = new Set<string>()
  if (spans.length === 0) return out
  // Joined into the stretches where any sounds, by start; the lines are in
  // order too, so one walk of each answers every line.
  spans.sort((a, b) => a.start - b.start)
  const sounding: { start: number; end: number }[] = []
  for (const sp of spans) {
    const last = sounding[sounding.length - 1]
    if (last && sp.start <= last.end) last.end = Math.max(last.end, sp.end)
    else sounding.push({ ...sp })
  }
  let j = 0
  for (const slot of prog.slots) {
    while (j < sounding.length && sounding[j].end <= slot.startSec) j++
    if (j < sounding.length && sounding[j].start < slot.startSec + slot.slotLenSec) out.add(slot.cellId)
  }
  return out
}

/**
 * AQU-2251: a verse "Skip lines with nothing to play" decides about — nothing
 * to hear (no original, no take the programme can play) and not hidden. A
 * hidden line is skipped whichever way the setting is: following the
 * recordings the playhead jumps it (Sam, Oct 29). (Following the source under
 * a film or a recording it is passed through instead — not this layout.)
 *
 * AQU-2252: a take on another track is the line's to play too, and a line a
 * take from another line runs on over (`underLayers`) is held under it.
 */
export function slotHasNothingToPlay(
  slot: ProgrammeSlot,
  hiddenCellIds: ReadonlySet<string>,
  underLayers: ReadonlySet<string> = new Set(),
): boolean {
  return !slotHasOwnSound(slot) && !underLayers.has(slot.cellId) && !hiddenCellIds.has(slot.cellId)
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

/**
 * AQU-2215 (Sam, Oct 27): whether a take on this line can carry a PAUSE
 * before it — exactly the conditions `buildProgramme` keeps one under, so a
 * take the timeline lets you drag is always a take whose new pause the
 * programme reads back. A take of unknown length has no window, so it cannot
 * hold one, and letting its chip be dragged would spring it back.
 */
export function canCarryTargetLead(_cell: CellData, slot: ProgrammeSlot): boolean {
  // AQU-1758 (Sam's decision 3): a line with no times of its own measures
  // the pause from its slot's start, and a split take's pieces each carry
  // one. Only a take of unknown length stays where it is.
  return slot.targetWindow != null
}

/**
 * AQU-2215: the pause a move gesture is asking for — where the take's audible
 * start was dragged to, measured from its line's start on the programme clock.
 *
 * Following the recordings a take moves only INSIDE its own line: dragging
 * right grows the pause (and the line with it, so the lines after move along),
 * dragging left shrinks it back to none. Zero is the floor — a take never
 * starts before the line it performs — and anything under
 * `MIN_TARGET_LEAD_SEC` is the same placement wobble `buildProgramme` already
 * reads as no pause, so the gesture stores none rather than a value the
 * layout would then ignore.
 */
export function leadSecForMove(slot: ProgrammeSlot, audibleStartSec: number): number {
  const lead = audibleStartSec - slot.startSec
  return lead >= MIN_TARGET_LEAD_SEC ? lead : 0
}

/**
 * AQU-1758: `leadSecForMove` for piece `at` of the line's split take — the
 * place to store (from its line's start, as `pauseAskedSec` reads it) for a
 * piece whose sound was dragged to `audibleStartSec`. The inverse of
 * `pieceAtSec`: held against the piece in front, as the programme holds it,
 * then measured back without the pieces before it, so following the source
 * the piece moves by exactly the distance it was dragged here.
 *
 * AQU-2252: `pieces` are the take's pieces as the programme placed them —
 * the main take's (`targetPieces`) unless given, or those of a take on an
 * added track that sets line lengths (its layers, in order), whose pieces
 * have the same one place.
 */
export function pieceLeadSecForMove(
  slot: ProgrammeSlot,
  at: number,
  audibleStartSec: number,
  pieces: readonly Pick<ProgrammePiece, "start" | "end" | "atSec">[] = slot.targetPieces ?? [],
): number {
  let heard = 0
  for (let i = 0; i < at; i++) heard += pieces[i].end - pieces[i].start
  const prev = at > 0 ? pieces[at - 1] : null
  const floor = prev ? prev.atSec + (prev.end - prev.start) : 0
  const lead = audibleStartSec - slot.startSec
  return (lead - floor >= MIN_TARGET_LEAD_SEC ? lead : floor) - heard
}
