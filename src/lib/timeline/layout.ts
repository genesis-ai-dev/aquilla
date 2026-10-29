// AQU-646 SUB-53 — one place that answers "where does this go on the track?".
//
// The Media lens now serves two jobs, and they disagree about what the x-axis
// means. In DUBBING the axis is the imported recording's own clock, so every
// card sits exactly where it really is in the file. In AUDIO-FIRST the axis is
// the assembled programme: each verse gets a slot as long as its longer side,
// laid end to end, so a translation running twice the length of its original
// stops dragging everything after it out of alignment.
//
// Rather than sprinkle `mode === ...` through four components, the editor
// builds one of these and the lanes just ask it. In dubbing mode every method
// is the pre-SUB-53 function verbatim, so that path is unchanged.

import { subtitleSpanSec, targetChipGeom, type SpanSec, type TargetChipGeom } from "./lane-timing"
import {
  buildProgramme,
  canCarryTargetLead,
  fileSpanToProgrammeSpan,
  leadSecForMove,
  type BuildProgrammeOptions,
  type Programme,
  type ProgrammeLayer,
  type ProgrammeSlot,
} from "./programme"
import { isDefaultTrackSlot } from "./track-slots"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { AudioTimingMode } from "@/lib/parsers/types"

/** What the layout needs off a take to place its chip. AQU-646 stage 3 added
 *  `targetOffsetMs` — the take's OWN placement, which outranks the line's. */
type Att =
  | Pick<CodexCellAttachment, "durationMs" | "trimStartMs" | "trimEndMs" | "targetOffsetMs">
  | undefined

export interface TimelineLayout {
  mode: AudioTimingMode
  /** The laid-out verses, in audio-first only. Null in dubbing mode. */
  programme: Programme | null
  /** Track width in the layout's own seconds, padding included. */
  totalSec: number
  /** Where a card sits in its lane. */
  spanFor(cell: CellData, lane: "subtitle" | "source"): SpanSec | null
  /**
   * Where a section's dub chip sits, and its trim state.
   *
   * AQU-2252: `audioId` names the take. Following the recordings a take on an
   * added track is a LAYER, placed and sized on its own, so asking about one
   * without naming it would get the main take's answer. Every caller that has
   * the take's id passes it; leaving it out asks about the main take.
   */
  targetGeom(cell: CellData, att: Att, audioId?: string): TargetChipGeom | null
  /**
   * The span a dub chip is measured and clamped against. In dubbing that's the
   * frozen source split. In audio-first it runs from the clip's own zero (so
   * the head trim can be dragged back off) to the end of the verse's slot —
   * and for a take on a track made a layer (AQU-2252, Oct 29), it is the line's
   * slot itself, the way a take is measured against its line following the
   * source.
   */
  chipSection(cell: CellData, att: Att, audioId?: string): SpanSec | null
  /** Where clicking this cell should send playback, in the layout's seconds. */
  seekSecFor(cell: CellData): number | null
  /**
   * AQU-2215: whether a MOVE gesture on this take changes anything. Dubbing
   * moves any chip; following the recordings only a take that can hold a
   * pause before its line (`canCarryTargetLead`) — the others are computed
   * end to end and have nowhere to go.
   */
  canRetimeTarget(cell: CellData, att: Att, audioId?: string): boolean
  /**
   * The inverse of `targetGeom`, for the one thing a drag may change: the
   * FILE-clock anchor to STORE for a take whose audible start was dragged to
   * `audibleStartSec` on THIS layout's clock. Null when the take cannot be
   * moved here.
   *
   * Dubbing's clock IS the file clock, so the answer is the drag's own anchor.
   * Following the recordings the chip is drawn on the programme clock, which
   * nothing stores — what the drag actually changed is the take's pause before
   * its line, and that is an offset from the line's own start.
   */
  retimeAnchorSec(cell: CellData, att: Att, audibleStartSec: number, audioId?: string): number | null
  /**
   * AQU-2252: what this take is to its line while the file follows its
   * recordings — its take on the Language lane's main track ("main"), a take
   * on an added track that sets line lengths ("sets-length"), or one on a
   * track made a layer ("layer"), which is drawn, warned about and moved the
   * way takes are following the source. Null following the original, where
   * every take sits on the file clock alike, and for a take the programme
   * does not lay in.
   */
  takeRole(cell: CellData, audioId: string): TakeRole | null
}

/** AQU-2252: see `TimelineLayout.takeRole`. */
export type TakeRole = "main" | "sets-length" | "layer"

/** Trailing room past the last card, so the final chip isn't flush to the edge.
 *  Exported so the insert arithmetic can agree with the track rather than
 *  hard-coding the same 2. */
export const TRACK_PAD_SEC = 2

function sectionSpan(cell: CellData): SpanSec | null {
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null
  if (typeof endTime !== "number" || !Number.isFinite(endTime)) return null
  return { start: startTime, end: endTime }
}

function dubbingLayout(cells: readonly CellData[], mediaDurationSec?: number | null): TimelineLayout {
  let end = 0
  for (const c of cells) {
    if (typeof c.endTime === "number" && Number.isFinite(c.endTime) && c.endTime > end) end = c.endTime
  }
  // AQU-646: when the caller knows how long the FOOTAGE is, that is the floor.
  // For an imported recording the cells are the recording and this changes
  // nothing; for a subtitle file timed against a video the last cue is usually
  // minutes short of the end, and that trailing stretch is reachable space
  // rather than padding — on the demo episode it is three minutes that no
  // amount of scrolling could get to.
  const floorSec =
    mediaDurationSec != null && Number.isFinite(mediaDurationSec) && mediaDurationSec > 0
      ? mediaDurationSec
      : 0
  return {
    mode: "dubbing",
    programme: null,
    totalSec: Math.max(end, floorSec) + TRACK_PAD_SEC,
    spanFor: (cell, lane) => (lane === "subtitle" ? subtitleSpanSec(cell) : sectionSpan(cell)),
    targetGeom: (cell, att) => targetChipGeom(cell, att),
    chipSection: (cell) => sectionSpan(cell),
    seekSecFor: (cell) =>
      typeof cell.startTime === "number" && Number.isFinite(cell.startTime) ? cell.startTime : null,
    canRetimeTarget: () => true,
    // The clip's sample zero sits a head-trim before its audible start — the
    // round-7 anchor, which is what the chip was already committing.
    retimeAnchorSec: (cell, att, audibleStartSec) => {
      const geom = targetChipGeom(cell, att)
      return geom ? audibleStartSec - geom.trimStartSec : null
    },
    takeRole: () => null,
  }
}

function audioFirstLayout(
  _cells: readonly CellData[],
  dialogue: readonly CellData[],
  opts?: BuildProgrammeOptions,
): TimelineLayout {
  const programme = buildProgramme(dialogue, opts)
  const slotOf = (cell: CellData): ProgrammeSlot | null => programme.byCellId.get(cell.id) ?? null
  /** AQU-2252: the take as a layer of its line, or null for the main take. */
  const layerOf = (slot: ProgrammeSlot, audioId: string | undefined): ProgrammeLayer | null =>
    audioId != null ? (slot.layers?.find((l) => l.audioId === audioId) ?? null) : null
  const lineStartOf = (cell: CellData): number =>
    typeof cell.startTime === "number" && Number.isFinite(cell.startTime) ? cell.startTime : 0

  /**
   * The dub chip, re-expressed against the programme clock. The trim maths in
   * TargetAudioLane works off `anchor` (where the clip's sample zero sits), so
   * placing the anchor a head-trim's worth BEFORE the slot start makes the
   * audible start land exactly on the slot start — and leaves every existing
   * resize calculation correct without touching it.
   */
  const geomFor = (cell: CellData, att: Att, audioId?: string): TargetChipGeom | null => {
    const slot = slotOf(cell)
    if (!slot) return null
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
    // AQU-2252: a layer is drawn where it was put, at its own length — the
    // programme placed it (`ProgrammeLayer`) and the transport plays it there.
    // One of unknown length borrows its line's width from its own start, and
    // says so, like the main take below.
    const layer = layerOf(slot, audioId)
    if (layer) {
      const start = slot.startSec + layer.atSec
      return layer.window
        ? {
            anchor: slot.startSec + layer.anchorSec,
            start,
            end: start + (layer.window.end - layer.window.start),
            trimStartSec,
            trimEndSec,
            durationSec,
            usingFallback: false,
          }
        : {
            anchor: start - trimStartSec,
            start,
            end: start + slot.slotLenSec,
            trimStartSec,
            trimEndSec: null,
            durationSec: null,
            usingFallback: true,
          }
    }
    const anchor = slot.startSec - trimStartSec
    // No honest length → the chip borrows the verse's width and says so,
    // exactly as it does in dubbing mode.
    if (slot.targetWindow == null) {
      return {
        anchor,
        start: slot.startSec,
        end: slot.startSec + slot.slotLenSec,
        trimStartSec,
        trimEndSec: null,
        durationSec: null,
        usingFallback: true,
      }
    }
    // AQU-1767 (Sam, 2026-10-15): a split take's pieces sit in the line's
    // slot in the order they come in the recording — the way its joined copy
    // plays them. A piece is known by where it starts in the recording;
    // pieces never share audio, so no two start in the same place. AQU-1758:
    // each where it was placed (`atSec`), the gaps between them silence.
    const pieces = slot.targetPieces
    const at = pieces ? pieces.findIndex((p) => Math.abs(p.start - trimStartSec) < 1e-6) : -1
    if (pieces && at >= 0) {
      const start = slot.startSec + pieces[at].atSec
      return {
        anchor: start - trimStartSec,
        start,
        end: start + (pieces[at].end - pieces[at].start),
        trimStartSec,
        trimEndSec,
        durationSec,
        usingFallback: false,
      }
    }
    // AQU-2204: a pause someone left before the take stays inside its line,
    // so the take starts that far into the slot.
    const start = slot.startSec + (slot.targetLeadSec ?? 0)
    return {
      anchor: start - trimStartSec,
      start,
      end: start + slot.targetLenSec,
      trimStartSec,
      trimEndSec,
      durationSec,
      usingFallback: false,
    }
  }

  return {
    mode: "audioFirst",
    programme,
    // AQU-2252: the programme reaches a layer that runs on past the last line.
    totalSec: programme.totalSec + TRACK_PAD_SEC,
    spanFor: (cell, lane) => {
      const slot = slotOf(cell)
      if (slot) {
        // The subtitle card covers the whole verse, so the text stays readable
        // for as long as the verse lasts; the source card is drawn at the
        // original's real length, which is what makes the gap after it visible.
        return lane === "subtitle"
          ? { start: slot.startSec, end: slot.startSec + slot.slotLenSec }
          : { start: slot.startSec, end: slot.startSec + slot.cardLenSec }
      }
      // A card that isn't itself a verse — a real subtitle cell in a mixed
      // file. Its timing is against the imported recording, so move it.
      const span = lane === "subtitle" ? subtitleSpanSec(cell) : sectionSpan(cell)
      if (!span) return null
      return fileSpanToProgrammeSpan(programme, span.start, span.end)
    },
    targetGeom: geomFor,
    chipSection: (cell, att, audioId) => {
      const slot = slotOf(cell)
      if (!slot) return null
      const geom = geomFor(cell, att, audioId)
      // AQU-2252 (Sam, Oct 29): a take on a track made a layer is measured
      // against its line, as a take is following the source — so it turns
      // amber running past the line and red over the next take on its track.
      // One on a track that sets line lengths is measured as the main take is.
      if (layerOf(slot, audioId)?.setsLength === false) {
        return { start: slot.startSec, end: slot.startSec + slot.slotLenSec }
      }
      return {
        start: geom?.anchor ?? slot.startSec,
        end: slot.startSec + slot.slotLenSec,
      }
    },
    seekSecFor: (cell) => programme.byCellId.get(cell.id)?.startSec ?? null,
    canRetimeTarget: (cell, _att, audioId) => {
      const slot = slotOf(cell)
      // AQU-2252: a layer's place is its own stored offset, which the next
      // layout reads straight back — so it moves whatever its length. A take
      // on a track that sets line lengths carries a pause, as the main take
      // does, once its length is known.
      const layer = slot ? layerOf(slot, audioId) : null
      if (layer) return layer.setsLength ? layer.window != null : true
      return slot != null && canCarryTargetLead(cell, slot)
    },
    // AQU-2215 (Sam, Oct 27): "it should still be possible for me to move a
    // recorded take around in the timeline." It is the PAUSE before the take
    // that moves — the one thing about a take's placement that following the
    // recordings keeps (AQU-2204) — so the drag's programme-clock start comes
    // back as a file-clock anchor whose offset IS that pause. The line grows
    // to hold it on the next build, which is what carries the later lines
    // along; nothing about the programme clock is ever stored.
    retimeAnchorSec: (cell, att, audibleStartSec, audioId) => {
      const slot = slotOf(cell)
      if (!slot) return null
      // AQU-2252: a take on a track made a layer stores where its clip's
      // sample zero goes — a head trim before where its sound was dropped,
      // before its line's start too (its lead-in): the chip's own move clamp
      // keeps it touching its line and off its neighbour, as following the
      // source. A take on a track that sets line lengths stores its pause, as
      // the main take does.
      const layer = layerOf(slot, audioId)
      if (layer && !layer.setsLength) {
        const trimStartSec = layer.window?.start ?? (att?.trimStartMs != null && att.trimStartMs > 0 ? att.trimStartMs / 1000 : 0)
        return lineStartOf(cell) + (audibleStartSec - slot.startSec) - trimStartSec
      }
      if (layer) return layer.window ? lineStartOf(cell) + leadSecForMove(slot, audibleStartSec) : null
      if (!canCarryTargetLead(cell, slot)) return null
      // AQU-1758: a line with no times of its own stores the pause from its
      // slot's start (a line start of 0), on the take — or on the piece, for
      // a split take, each piece where it was dragged.
      return lineStartOf(cell) + leadSecForMove(slot, audibleStartSec)
    },
    takeRole: (cell, audioId) => {
      const slot = slotOf(cell)
      if (!slot) return null
      const layer = layerOf(slot, audioId)
      if (layer) return layer.setsLength ? "sets-length" : "layer"
      // A take the programme did not lay in as one of the line's other takes
      // is the main track's only if it is stored on it.
      const stored = cell.attachments?.[audioId]?.slot
      return stored == null || isDefaultTrackSlot(stored) ? "main" : null
    },
  }
}

/**
 * `cells` is everything on the file (for the track's extent); `dialogue` is
 * the time-sorted media lane from deriveLanes, which IS the programme's order.
 *
 * `mediaDurationSec` (AQU-646) is a FLOOR on the track's length, and applies to
 * the dubbing layout only. Free timing lays verses end to end on its own clock,
 * where the footage's length means nothing. Pass it only when the source-audio
 * band is drawing: a file with real media cells that also has a video linked
 * would otherwise get a track sized to the video while its chips still mean
 * file-clock seconds.
 */
export function buildTimelineLayout(
  mode: AudioTimingMode,
  cells: readonly CellData[],
  dialogue: readonly CellData[],
  mediaDurationSec?: number | null,
  /** AQU-2204: stand-in lengths for lines with no times (audio-first only). */
  programmeOptions?: BuildProgrammeOptions,
): TimelineLayout {
  return mode === "audioFirst"
    ? audioFirstLayout(cells, dialogue, programmeOptions)
    : dubbingLayout(cells, mediaDurationSec)
}
