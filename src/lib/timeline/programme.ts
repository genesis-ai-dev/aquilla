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
import { storedRoomSec, type LineRoomChange } from "./line-room"

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
   * AQU-2432 (Sam, Nov 6): how far this line was PULLED BACK over the end of
   * the line before it — a take of its (on any track that sets line lengths)
   * dragged earlier than where its line would start, so one speaker comes in
   * before the other has finished. The pause rule run backwards: the line
   * starts this much earlier, the line before it is that much shorter (its
   * take plays on to its end under this one), and every later line moves up
   * by as much. Its takes' places are still measured from where the line
   * would have started (`naturalStartSec`), so a move is one distance in both
   * timings. Absent when nothing of the line starts before that.
   */
  pulledBackSec?: number
  /**
   * AQU-2432 (Sam, Nov 9): an UNRECORDED line whose ROOM was made smaller than
   * its natural length — the next take dragged earlier against it
   * (lib/timeline/line-room). `slotLenSec` is its room, down to 0; this is the
   * natural length it would last, and gets back when that take is dragged
   * later. Absent on a line at its natural length, and on every line with a
   * take (its take sets its length; a stored room is ignored).
   */
  naturalLenSec?: number
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
 *     So it never runs past its line — unless the line after it is pulled
 *     back over it (AQU-2432), when it plays on to its end under that one.
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
 * keeps its own such place — see `pauseAsked`). A cut leaves every piece
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
  /**
   * AQU-2432 (Sam, Nov 6): the piece was dragged earlier, over the end of the
   * piece in front of it — it starts this long before that piece ends, and
   * both play, mixed (never before that piece's start). Absent when they
   * touch or a gap is left (`gapBeforeSec`).
   */
  overlapBeforeSec?: number
}

/** A pause shorter than this is a placement wobble, not a pause. */
export const MIN_TARGET_LEAD_SEC = 0.05

/** AQU-2432: a room within this of the line's natural length is that length
 *  (the room is stored in whole ms; the natural length is not). */
const ROOM_EPS_SEC = 0.0005

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
 *
 * AQU-2432 (Sam, Nov 6): `own` says the place is the take's OWN place
 * following the recordings. Only such a place may put a take before its line's
 * start (pulled back over the end of the take before it): a take read from its
 * place following the source — where a take routinely leads its line — keeps
 * starting on its line here, exactly as before.
 */
function pauseAsked(
  cell: CellData,
  att: NonNullable<CellData["attachments"]>[string] | undefined,
  untimed: boolean,
): { sec: number; own: boolean } {
  // `!= null`-style: 0 is a real place (the line's own start), never "none".
  const placedHere = att?.recordingsOffsetMs
  if (typeof placedHere === "number" && Number.isFinite(placedHere)) return { sec: placedHere / 1000, own: true }
  if (untimed) {
    const ms = att?.targetOffsetMs
    return { sec: typeof ms === "number" && Number.isFinite(ms) ? ms / 1000 : 0, own: false }
  }
  const geom = targetChipGeom(cell, att)
  return { sec: geom && typeof cell.startTime === "number" ? geom.anchor - cell.startTime : 0, own: false }
}

/**
 * Where a take (or a split take's first piece) starts, from where its line
 * would start (`naturalStartSec`), for its place `asked`:
 *   - a pause after it (AQU-2204), at least `MIN_TARGET_LEAD_SEC`, is kept;
 *   - AQU-2432 (Sam, Nov 6): a place before it — the take dragged earlier,
 *     over the end of the take before it on its track — is kept too when it is
 *     the take's own place following the recordings, held at `floorSec` (≤ 0):
 *     up to the start of the take before it, never past, so the two overlap
 *     but never swap order;
 *   - anything nearer than the wobble is the line's own start.
 */
function leadFromAsked(asked: { sec: number; own: boolean }, floorSec: number): number {
  if (asked.sec >= MIN_TARGET_LEAD_SEC) return asked.sec
  if (asked.own && asked.sec <= -MIN_TARGET_LEAD_SEC) return Math.min(0, Math.max(asked.sec, floorSec))
  return 0
}

/**
 * AQU-1758: where a piece of a split take after the first sits following the
 * recordings, from its place (`pauseAsked`) and how long the pieces before it
 * sound (`heardBeforeSec`), against the piece in front, which starts at
 * `prevStartSec` and ends at `prevEndSec`. Following the source the same place
 * puts the piece where its sound is in the take; here the parts of the take
 * nobody hears are left out — its head trim and anything cut away between the
 * pieces — so its untouched pieces sit end to end.
 *
 * Before AQU-2432 a piece never sat over the piece in front: one that would
 * was put at its end. AQU-2432 (Sam, Nov 6: the same rule for pieces of a cut
 * take): a piece with its own place following the recordings may sit over the
 * end of the piece in front, never before its start — both play, mixed. A
 * piece read from its place following the source keeps the old rule.
 */
function pieceAtSec(asked: { sec: number; own: boolean }, heardBeforeSec: number, prevStartSec: number, prevEndSec: number): number {
  const at = asked.sec + heardBeforeSec
  if (at - prevEndSec >= MIN_TARGET_LEAD_SEC) return at
  if (asked.own && at - prevEndSec <= -MIN_TARGET_LEAD_SEC) return Math.max(at, prevStartSec)
  return prevEndSec
}

/**
 * AQU-2432: the start of the last clip on `track` (null: the main track) in
 * `slot`, on the programme clock — a take, or a split take's last piece. Null
 * when the line has no take there of known length.
 */
function lastClipStartSec(slot: ProgrammeSlot, track: string | null): number | null {
  if (track == null) {
    if (!slot.targetWindow) return null
    const pieces = slot.targetPieces
    return slot.startSec + (pieces ? pieces[pieces.length - 1].atSec : (slot.targetLeadSec ?? 0))
  }
  let last: number | null = null
  for (const l of slot.layers ?? []) {
    if (l.slot !== track || !l.setsLength || !l.window) continue
    const at = slot.startSec + l.atSec
    if (last == null || at > last) last = at
  }
  return last
}

/**
 * AQU-2432 (Sam, Nov 9): a line NOBODY HAS RECORDED — no take on the main
 * track nor on any track that sets line lengths, so its length is its natural
 * one (a stand-in, its own span, its original's) or the room it was given. A
 * take on a track made a layer sets nothing, so it does not count; a take
 * whose length is not known yet does.
 */
export function isUnrecordedSlot(slot: ProgrammeSlot): boolean {
  return slot.targetLenSec === 0 && !slot.layers?.some((l) => l.setsLength)
}

/**
 * AQU-2432 (Sam, Nov 6, rule 4): the earliest a take on `track` (null: the
 * main track) in the line after `prev` may start, following the recordings —
 * the start of the take before it on its track: up to it, never past, so the
 * two can overlap but never swap order. Never before the start of the line
 * before it either (the lines keep their order, whatever is on the track),
 * and the first line never before the start of the file. On the programme
 * clock. The timeline's move clamp asks the same (`TimelineLayout.moveBounds`).
 *
 * AQU-2432 (Sam, Nov 9): OVERLAP IS ONLY OVER A TAKE. When the line before is
 * unrecorded there is no take to come in over, so the take starts no earlier
 * than that line's end — and a pull-back stored on it from before this rule
 * reads as none. What a drag against such a line changes is that line's ROOM
 * (`roomsForMove`), never the take.
 */
export function pullFloorSec(prev: ProgrammeSlot | null, track: string | null): number {
  if (!prev) return 0
  if (isUnrecordedSlot(prev)) return prev.startSec + prev.slotLenSec
  return Math.max(prev.startSec, lastClipStartSec(prev, track) ?? -Infinity)
}

/**
 * AQU-2432: where a line WOULD start — the end of the line before it — on the
 * programme clock. Its takes' places following the recordings are measured
 * from here; a line pulled back over the one before it starts earlier
 * (`pulledBackSec`).
 */
export function naturalStartSec(slot: ProgrammeSlot): number {
  return slot.startSec + (slot.pulledBackSec ?? 0)
}

/**
 * AQU-2432: where the last of a line's own sound ends on the programme clock —
 * its slot, and its take on the main track, which plays on past the slot's end
 * when the line after it was pulled back over it.
 */
function mainTakeEndSec(slot: ProgrammeSlot): number {
  return slot.targetWindow ? slot.startSec + (slot.targetLeadSec ?? 0) + slot.targetLenSec : slot.startSec
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
 * head trim), its length, and for a split take each piece where it was put.
 * `slot` absent is the main track.
 *
 * Every place here is measured from where the line WOULD start
 * (`naturalStartSec`); the caller moves them onto its slot once it knows how
 * far the line was pulled back (AQU-2432).
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
  /** The pause before it (0 when none worth keeping). AQU-2432: below 0 when
   *  it was pulled back over the end of the take before it on its track. */
  leadSec: number
}

/**
 * `floorSec` (≤ 0, from where the line would start): the earliest the take may
 * start — the start of the take before it on its track (AQU-2432,
 * `pullFloorSec`).
 */
function placeTake(cell: CellData, untimed: boolean, floorSec: number, slot?: string): PlacedTake {
  const refs = resolveTargetPieces(cell, slot)
  const target = refs[0] ?? null
  const att = target ? cell.attachments?.[target.audioId] : undefined
  // AQU-1767: a split take sounds as all its pieces, back to back — but only
  // when every piece's length is known; otherwise its first piece, as before.
  // AQU-1758 (Sam's decision 3): each piece sits where it was placed; a gap
  // someone dragged open between two pieces is deliberate silence inside the
  // line, joined into the copy as silence. AQU-2432: a piece dragged over the
  // end of the one in front sounds over it, mixed into the copy.
  const split = refs.length > 1 ? splitWindows(cell, refs) : null
  let pieces: ProgrammePiece[] | null = null
  let splitLeadSec = 0
  let splitSpanMs = 0
  if (split) {
    let prevStart = 0
    let prevEnd = 0
    let reach = -Infinity
    let heard = 0
    pieces = split.pieces.map((p, i) => {
      const asked = pauseAsked(cell, cell.attachments?.[p.audioId], untimed)
      // The first piece is the take's start: placed as a take is.
      const atSec = i === 0 ? leadFromAsked({ sec: asked.sec + heard, own: asked.own }, floorSec) : pieceAtSec(asked, heard, prevStart, prevEnd)
      const gap = atSec - prevEnd
      prevStart = atSec
      prevEnd = atSec + (p.end - p.start)
      reach = Math.max(reach, prevEnd)
      heard += p.end - p.start
      return {
        ...p,
        atSec,
        ...(i > 0 && gap > 0 ? { gapBeforeSec: gap } : {}),
        ...(i > 0 && gap < 0 ? { overlapBeforeSec: -gap } : {}),
      }
    })
    splitLeadSec = pieces[0].atSec
    // AQU-2432: a piece over the one in front can end before it does, so the
    // take lasts to whichever of them ends last.
    splitSpanMs = (reach - splitLeadSec) * 1000
  }
  const effMs = split ? splitSpanMs : effectiveAttachmentDurationMs(att)
  const trimStartSec = split ? 0 : trimStartSecOf(att)
  const window: Window | null = target && effMs != null ? { start: trimStartSec, end: trimStartSec + effMs / 1000 } : null
  // AQU-2204: a pause someone left before the take stays inside its line.
  // It is where the take was PLACED (its clip's start against the line's),
  // never a head trim, which only removes the start of the recording. Only a
  // take with a known length can carry one. AQU-1758: on a line with no
  // times too (measured from the slot's start), and a split take's first
  // piece carries the take's. AQU-2432: a place before the line's start,
  // when it is the take's own (`leadFromAsked`).
  const leadSec = !window ? 0 : split ? splitLeadSec : leadFromAsked(pauseAsked(cell, att, untimed), floorSec)
  return {
    target,
    pieces,
    lenSec: target && effMs != null ? effMs / 1000 : null,
    window,
    leadSec,
  }
}

/** AQU-2252: a take on an added track that sets its line's length, piece by
 *  piece, placed as `placeTake` placed it (see `ProgrammeLayer`) — on a line
 *  that starts `pulledBackSec` before where it would (AQU-2432). */
function lengthSettingLayers(slot: string, cell: CellData, placed: PlacedTake, pulledBackSec: number): ProgrammeLayer[] {
  if (!placed.target) return []
  if (placed.pieces) {
    return placed.pieces.map((p) => {
      const atSec = p.atSec + pulledBackSec
      return {
        slot, audioId: p.audioId, atSec, anchorSec: atSec - p.start,
        window: { start: p.start, end: p.end }, setsLength: true,
      }
    })
  }
  const trimStartSec = trimStartSecOf(cell.attachments?.[placed.target.audioId])
  const atSec = placed.leadSec + pulledBackSec
  return [{
    slot,
    audioId: placed.target.audioId,
    atSec,
    anchorSec: atSec - trimStartSec,
    window: placed.window,
    setsLength: true,
  }]
}

/** AQU-2252: a take on a track made a LAYER — every piece of it, each placed on
 *  its own the way a take is placed following the source (see `ProgrammeLayer`).
 *  `lineStartSec` is where its line would start on the programme clock
 *  (`naturalStartSec`), which its place is measured from: nothing sounds
 *  before the file's start. AQU-2432: on a line that starts `pulledBackSec`
 *  earlier than that, it stays where it was put. */
function layerTrackLayers(slot: string, cell: CellData, untimed: boolean, lineStartSec: number, pulledBackSec: number): ProgrammeLayer[] {
  const out: ProgrammeLayer[] = []
  for (const piece of resolveTargetPieces(cell, slot)) {
    const att = cell.attachments?.[piece.audioId]
    const trimStartSec = trimStartSecOf(att)
    // The stored place is the clip's sample zero, from the line's start.
    const atSec = Math.max(-lineStartSec, pauseAsked(cell, att, untimed).sec + trimStartSec) + pulledBackSec
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

/**
 * AQU-2432: the line before one pulled back `bySec` over it — that much
 * shorter, its original cut where it now ends. Its takes stay where they
 * were, so its take on the main track (and any on a track that sets line
 * lengths) plays on past its end, under the line after it.
 */
function shortenedSlot(slot: ProgrammeSlot, bySec: number): ProgrammeSlot {
  const slotLenSec = Math.max(0, slot.slotLenSec - bySec)
  const sourceLenSec = slot.sourceWindow ? Math.min(slot.nominalLenSec, slotLenSec) : 0
  return {
    ...slot,
    slotLenSec,
    sourceLenSec,
    sourceWindow: slot.sourceWindow ? { start: slot.sourceWindow.start, end: slot.sourceWindow.start + sourceLenSec } : null,
    cardLenSec: sourceLenSec > 0 ? sourceLenSec : slotLenSec,
  }
}

/** AQU-2432: how far a line's own sound reaches on the programme clock — its
 *  slot, its main take (which may run on past it) and its other tracks. */
function slotReachSec(slot: ProgrammeSlot): number {
  return Math.max(slot.startSec + slot.slotLenSec, mainTakeEndSec(slot), layersReachSec(slot.startSec, slot.layers))
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

    // AQU-2432 (Sam, Nov 6, rule 4): how far back each track's take may be
    // pulled, from where this line would start: to the start of the take
    // before it on its track (`pullFloorSec`).
    const prev = slots.length > 0 ? slots[slots.length - 1] : null
    const floorOf = (track: string | null) => Math.min(0, pullFloorSec(prev, track) - cursor)

    // The main track's take, and AQU-2252 the line's takes on its other
    // tracks: each on a track that sets line lengths placed as the main take
    // is, each on a track made a layer placed against the line.
    const main = placeTake(cell, untimed, floorOf(null))
    const target = main.target
    // A dub whose length genuinely isn't known borrows the section's, which is
    // what its chip already draws at (targetChipGeom's `usingFallback`). It
    // gets no playback window — there's no honest trim to play.
    const targetLenSec = target ? (main.lenSec ?? nominalLenSec) : 0
    const targetWindow = main.window
    const layerTracks = new Set(opts?.layerTrackSlots ?? [])
    const extraSlots = [...new Set(opts?.layerSlots ?? Object.keys(cell.selectedBySlot ?? {}))]
      .filter((slot) => !isDefaultTrackSlot(slot))
    const lengthTakes: PlacedTake[] = target ? [main] : []
    const lengthTracks: [string, PlacedTake][] = []
    for (const slot of extraSlots) {
      if (layerTracks.has(slot)) continue
      const placed = placeTake(cell, untimed, floorOf(slot), slot)
      if (!placed.target) continue
      lengthTakes.push(placed)
      lengthTracks.push([slot, placed])
    }
    // AQU-2432 (Sam, Nov 6, rule 3): FOLLOWING THE RECORDINGS, THE LATER LINES
    // MOVE UP — the pause rule run backwards. A take pulled 0.5 s earlier than
    // where its line would start (over the end of the take before it) starts
    // its line 0.5 s earlier; the line before it is that much shorter, its
    // take playing on under this one; and every later line moves up 0.5 s.
    // The line starts with the earliest of its takes on the tracks that set
    // line lengths; each take stays where it was put.
    let pulledBackSec = 0
    let recordedEndSec = -Infinity
    for (const take of lengthTakes) {
      if (!take.window || take.lenSec == null) continue
      pulledBackSec = Math.max(pulledBackSec, -take.leadSec)
      recordedEndSec = Math.max(recordedEndSec, take.leadSec + take.lenSec)
    }
    const startSec = cursor - pulledBackSec
    if (prev && pulledBackSec > 0) {
      const shorter = shortenedSlot(prev, pulledBackSec)
      slots[slots.length - 1] = shorter
      byCellId.set(shorter.cellId, shorter)
    }
    const targetLeadSec = main.leadSec + pulledBackSec
    const placedPieces = main.pieces?.map((p) => ({ ...p, atSec: p.atSec + pulledBackSec })) ?? null
    const layers: ProgrammeLayer[] = []
    for (const [slot, placed] of lengthTracks) layers.push(...lengthSettingLayers(slot, cell, placed, pulledBackSec))
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
    // A take on a track made a layer sets nothing. AQU-2432: from the earliest
    // of them, for a line pulled back.
    const recordedLenSec = recordedEndSec > -Infinity ? recordedEndSec + pulledBackSec : 0
    const recorded = lengthTakes.length > 0
    const usesStandIn = !recorded && (untimed || Boolean(opts?.standInLenSec))
    const unrecordedLenSec = untimed
      ? nominalLenSec
      : opts?.standInLenSec
        ? Math.max(MIN_TARGET_LEN_SEC, opts.standInLenSec(cell))
        : Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
    // AQU-2432 (Sam, Nov 9): AN UNRECORDED LINE'S ROOM. The next take dragged
    // earlier against a line nobody has recorded makes that line's room
    // smaller, down to nothing; the room is the line's own (stored on it, per
    // language — lib/timeline/line-room), never the dragged take's. It is at
    // most the line's natural length, and it is ignored the moment the line
    // has a take: its take sets its length then, as for any recorded line, so
    // a room closed long ago can never turn into an overlap.
    const roomSec = recorded ? null : storedRoomSec(cell)
    const roomCut = roomSec != null && roomSec < unrecordedLenSec - ROOM_EPS_SEC
    const slotLenSec = recordedLenSec > 0
      ? recordedLenSec
      : recorded
        ? Math.max(nominalLenSec, MIN_TARGET_LEN_SEC)
        : roomCut
          ? roomSec
          : unrecordedLenSec
    // A verse whose source clip is gone (generated-voice-only, or a lone take)
    // has NO original to hear; one that runs past the line is cut at its end.
    // AQU-2432 (Sam, Nov 9): a room shorter than the original cuts it there
    // too, and a line with no room at all has none of it left to hear.
    const sourceLenSec = fullSourceStart != null ? Math.min(nominalLenSec, slotLenSec) : 0
    const sourceWindow: Window | null =
      fullSourceStart != null && !(roomCut && sourceLenSec <= 0)
        ? { start: fullSourceStart, end: fullSourceStart + sourceLenSec }
        : null
    // The take clocks its line (the source never outlasts it now); a line with
    // no take is clocked by its source, else nothing plays and playback steps
    // over it. AQU-2252: a take on another track never clocks its line — the
    // transport holds the line around it.
    const clock: ProgrammeSlot["clock"] = targetWindow ? "target" : sourceWindow ? "source" : null
    // AQU-2252: the takes on the tracks made layers, placed against the line.
    for (const slot of extraSlots) {
      if (layerTracks.has(slot)) layers.push(...layerTrackLayers(slot, cell, untimed, cursor, pulledBackSec))
    }

    const slot: ProgrammeSlot = {
      cellId: cell.id,
      startSec,
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
      ...(pulledBackSec > 0 ? { pulledBackSec } : {}),
      ...(roomCut ? { naturalLenSec: unrecordedLenSec } : {}),
      ...(layers.length > 0 ? { layers } : {}),
    }
    slots.push(slot)
    byCellId.set(cell.id, slot)
    // AQU-2252: a layer may run on past the last line, and the file plays it
    // out to its end. AQU-2432: so may a take the last lines were pulled back
    // over.
    reachSec = Math.max(reachSec, slotReachSec(slot))
    cursor = startSec + slotLenSec
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
  const totalSec = slots.reduce((t, s) => Math.max(t, slotReachSec(s)), 0)
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
 * Following the recordings dragging a take right grows the pause (and the line
 * with it, so the lines after move along); anything under
 * `MIN_TARGET_LEAD_SEC` is the same placement wobble `buildProgramme` already
 * reads as no pause, so the gesture stores none rather than a value the
 * layout would then ignore.
 *
 * AQU-2432 (Sam, Nov 6): dragging it left of its line's start pulls it back
 * over the end of the take before it — a place below 0, the pause rule run
 * backwards. Measured from where the line WOULD start (`naturalStartSec`), so
 * a take of a line already pulled back reads its own place, not the line's.
 * The move clamp has already held it to the start of the take before it
 * (`pullFloorSec`); the programme holds it there again on reading.
 */
export function leadSecForMove(slot: ProgrammeSlot, audibleStartSec: number): number {
  const lead = audibleStartSec - naturalStartSec(slot)
  return Math.abs(lead) >= MIN_TARGET_LEAD_SEC ? lead : 0
}

/**
 * AQU-1758: `leadSecForMove` for piece `at` of the line's split take — the
 * place to store (from its line's start, as `pauseAsked` reads it) for a
 * piece whose sound was dragged to `audibleStartSec`. The inverse of
 * `pieceAtSec`: held against the piece in front, as the programme holds it,
 * then measured back without the pieces before it, so following the source
 * the piece moves by exactly the distance it was dragged here.
 *
 * AQU-2252: `pieces` are the take's pieces as the programme placed them —
 * the main take's (`targetPieces`) unless given, or those of a take on an
 * added track that sets line lengths (its layers, in order), whose pieces
 * have the same one place.
 *
 * AQU-2432 (Sam, Nov 6): a piece dragged over the end of the piece in front
 * keeps its place there, never before that piece's start; the first piece is
 * placed as a take is (`leadSecForMove`), over the take before it.
 */
export function pieceLeadSecForMove(
  slot: ProgrammeSlot,
  at: number,
  audibleStartSec: number,
  pieces: readonly Pick<ProgrammePiece, "start" | "end" | "atSec">[] = slot.targetPieces ?? [],
): number {
  let heard = 0
  for (let i = 0; i < at; i++) heard += pieces[i].end - pieces[i].start
  const base = naturalStartSec(slot)
  const lead = audibleStartSec - base
  const prev = at > 0 ? pieces[at - 1] : null
  if (!prev) return Math.abs(lead) >= MIN_TARGET_LEAD_SEC ? lead : 0
  const prevStart = slot.startSec + prev.atSec - base
  const prevEnd = prevStart + (prev.end - prev.start)
  const placed = lead - prevEnd >= MIN_TARGET_LEAD_SEC
    ? lead
    : lead - prevEnd <= -MIN_TARGET_LEAD_SEC
      ? Math.max(lead, prevStart)
      : prevEnd
  return placed - heard
}

/** AQU-2432 (Sam, Nov 9): what a move does to the rooms of the unrecorded
 *  lines before a take's line — see `roomsForMove`. */
export interface RoomMove {
  /** Each line whose room the move changes, with the room it is left. */
  rooms: LineRoomChange[]
  /**
   * Where the take's own start goes, ON THE LAYOUT AS IT IS NOW, once the
   * rooms have taken their share of the move: what its own place (the pause
   * before it) is then read from. The same as where it was when the rooms
   * took all of it — nothing is stored on the take then.
   */
  takeStartSec: number
}

/** AQU-2432: the unrecorded lines directly before `slot`, nearest first. */
function unrecordedRunBefore(prog: Programme, slot: ProgrammeSlot): ProgrammeSlot[] {
  const run: ProgrammeSlot[] = []
  for (let i = slotIndex(prog, slot.cellId) - 1; i >= 0 && isUnrecordedSlot(prog.slots[i]); i--) run.push(prog.slots[i])
  return run
}

/**
 * AQU-2432 (Sam, Nov 9, rule 4): how far EARLIER a take of `slot` may be
 * dragged by closing the rooms of the unrecorded lines directly before its
 * line — to where they start: the end of the nearest recorded line before it
 * (the start of the file with none). It stops there; it does not go on to
 * overlap that recorded take across the empty lines. Null when the line
 * before is recorded (or there is none): no room to close.
 */
export function roomFloorSec(prog: Programme, slot: ProgrammeSlot): number | null {
  const run = unrecordedRunBefore(prog, slot)
  return run.length > 0 ? run[run.length - 1].startSec : null
}

/**
 * AQU-2432 (Sam, Nov 9): A DRAG AGAINST AN UNRECORDED LINE SETS THAT LINE'S
 * ROOM. For a take of `slot` (on the main track or a track that sets line
 * lengths; a cut take's first piece) moved from `fromStartSec` to
 * `toStartSec`, both on the programme clock as it is now:
 *
 *   - EARLIER: its own pause closes first (as it always did); past its line's
 *     start, the line before gives up room, down to nothing, then the
 *     unrecorded line before that, and so on — each its own room;
 *   - LATER: the line before gets room back first, up to its natural length,
 *     then the unrecorded line before that; only past that does the rest of
 *     the drag become the take's own pause.
 *
 * The line directly before the take is always the one that changes first, so
 * what its marker says ("drag the next take later to give it room") is true
 * of the next drag. Null when the move changes no room (the line before is
 * recorded, or the move is under the wobble): the move is the take's alone.
 *
 * AQU-2432 (review, Nov 9): DELIBERATE — a room is the empty LINE's, so the
 * share of a drag the rooms take moves the whole of the take's line: its takes
 * on every other track move up (or back) with it. Dragging Boaz's voice take
 * against an empty line moves the narrator's take on the same line too; only
 * against a recorded line does the dragged take move alone (its pull-back is
 * its own place). line-room.test.ts pins both.
 */
export function roomsForMove(
  prog: Programme,
  slot: ProgrammeSlot,
  fromStartSec: number,
  toStartSec: number,
): RoomMove | null {
  const run = unrecordedRunBefore(prog, slot)
  if (run.length === 0) return null
  const delta = toStartSec - fromStartSec
  const rooms: LineRoomChange[] = []
  if (delta < 0) {
    const ownPause = Math.min(Math.max(0, fromStartSec - naturalStartSec(slot)), -delta)
    let close = -delta - ownPause
    if (close < MIN_TARGET_LEAD_SEC) return null
    for (const line of run) {
      const by = Math.min(line.slotLenSec, close)
      if (by <= 0) continue
      rooms.push({ cellId: line.cellId, roomMs: Math.max(0, Math.round((line.slotLenSec - by) * 1000)) })
      close -= by
      if (close <= ROOM_EPS_SEC) break
    }
    return rooms.length > 0 ? { rooms, takeStartSec: fromStartSec - ownPause } : null
  }
  if (delta < MIN_TARGET_LEAD_SEC) return null
  let give = delta
  for (const line of run) {
    const natural = line.naturalLenSec ?? line.slotLenSec
    const by = Math.min(natural - line.slotLenSec, give)
    if (by <= 0) continue
    const room = line.slotLenSec + by
    // Back at its natural length: nothing is stored.
    rooms.push({ cellId: line.cellId, roomMs: room >= natural - ROOM_EPS_SEC ? null : Math.round(room * 1000) })
    give -= by
    if (give <= ROOM_EPS_SEC) break
  }
  return rooms.length > 0 ? { rooms, takeStartSec: fromStartSec + Math.max(0, give) } : null
}

/**
 * AQU-2432 (review, Nov 9): RECORDING AN EMPTY LINE NEVER BRINGS BACK AN OLD
 * OVERLAP. A take's own place before its line's start (a pull-back, Nov 6)
 * reads as none while the line before it is unrecorded (`pullFloorSec`), but
 * the number stays on the take — and the moment that line gets a take it
 * would read again, starting the take over the NEW take: an overlap nobody
 * asked for (it was made over a take since deleted, or against the empty line
 * by an earlier build of this rule).
 *
 * So when a take lands on line `cellId`, these are the takes of the line after
 * it whose own place is before their line's start — on the main track and
 * every track that sets line lengths; a cut take's first piece carries the
 * take's place — provided `cellId` was unrecorded until then: nothing but
 * `newAudioIds` (the take that landed, and its pieces) records it, whether or
 * not they have reached `cells` yet. The caller puts each back on its line's
 * start, which is where it is drawn and heard now, in the recording's step.
 * A line that was already recorded is left alone: an overlap made over it was
 * asked for.
 */
export function pullBacksWokenBy(
  cells: readonly CellData[],
  cellId: string,
  newAudioIds: readonly string[],
  opts?: Pick<BuildProgrammeOptions, "layerSlots" | "layerTrackSlots">,
): { cellId: string; audioId: string }[] {
  const fresh = new Set(newAudioIds)
  const before = cells.map((c) => {
    if (c.id !== cellId || !c.attachments) return c
    const kept = Object.entries(c.attachments).filter(([id, a]) => !fresh.has(id) && !fresh.has(a?.pieceOf ?? ""))
    return { ...c, attachments: Object.fromEntries(kept) }
  })
  const { programme, lines } = layOutProgramme(before, opts)
  const at = slotIndex(programme, cellId)
  if (at < 0 || at + 1 >= programme.slots.length || !isUnrecordedSlot(programme.slots[at])) return []
  const nextId = programme.slots[at + 1].cellId
  const next = lines.find((c) => c.id === nextId)
  if (!next) return []
  const layers = new Set(opts?.layerTrackSlots ?? [])
  const tracks = [undefined, ...[...new Set(opts?.layerSlots ?? Object.keys(next.selectedBySlot ?? {}))]
    .filter((slot) => !isDefaultTrackSlot(slot) && !layers.has(slot))]
  const out: { cellId: string; audioId: string }[] = []
  for (const track of tracks) {
    const first = resolveTargetPieces(next, track)[0]
    const ms = first ? next.attachments?.[first.audioId]?.recordingsOffsetMs : undefined
    if (typeof ms === "number" && ms < 0) out.push({ cellId: nextId, audioId: first!.audioId })
  }
  return out
}
