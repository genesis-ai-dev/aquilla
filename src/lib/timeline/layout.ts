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
  fileSpanToProgrammeSpan,
  type Programme,
  type ProgrammeSlot,
} from "./programme"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { AudioTimingMode } from "@/lib/parsers/types"

type Att = Pick<CodexCellAttachment, "durationMs" | "trimStartMs" | "trimEndMs"> | undefined

export interface TimelineLayout {
  mode: AudioTimingMode
  /** The laid-out verses, in audio-first only. Null in dubbing mode. */
  programme: Programme | null
  /** Track width in the layout's own seconds, padding included. */
  totalSec: number
  /** Where a card sits in its lane. */
  spanFor(cell: CellData, lane: "subtitle" | "source"): SpanSec | null
  /** Where a section's dub chip sits, and its trim state. */
  targetGeom(cell: CellData, att: Att): TargetChipGeom | null
  /**
   * The span a dub chip is measured and clamped against. In dubbing that's the
   * frozen source split. In audio-first it runs from the clip's own zero (so
   * the head trim can be dragged back off) to the end of the verse's slot.
   */
  chipSection(cell: CellData, att: Att): SpanSec | null
  /** Where clicking this cell should send playback, in the layout's seconds. */
  seekSecFor(cell: CellData): number | null
}

/** Trailing room past the last card, so the final chip isn't flush to the edge. */
const TRACK_PAD_SEC = 2

function sectionSpan(cell: CellData): SpanSec | null {
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null
  if (typeof endTime !== "number" || !Number.isFinite(endTime)) return null
  return { start: startTime, end: endTime }
}

function dubbingLayout(cells: readonly CellData[]): TimelineLayout {
  let end = 0
  for (const c of cells) {
    if (typeof c.endTime === "number" && Number.isFinite(c.endTime) && c.endTime > end) end = c.endTime
  }
  return {
    mode: "dubbing",
    programme: null,
    totalSec: end + TRACK_PAD_SEC,
    spanFor: (cell, lane) => (lane === "subtitle" ? subtitleSpanSec(cell) : sectionSpan(cell)),
    targetGeom: (cell, att) => targetChipGeom(cell, att),
    chipSection: (cell) => sectionSpan(cell),
    seekSecFor: (cell) =>
      typeof cell.startTime === "number" && Number.isFinite(cell.startTime) ? cell.startTime : null,
  }
}

function audioFirstLayout(_cells: readonly CellData[], dialogue: readonly CellData[]): TimelineLayout {
  const programme = buildProgramme(dialogue)
  const slotOf = (cell: CellData): ProgrammeSlot | null => programme.byCellId.get(cell.id) ?? null

  /**
   * The dub chip, re-expressed against the programme clock. The trim maths in
   * TargetAudioLane works off `anchor` (where the clip's sample zero sits), so
   * placing the anchor a head-trim's worth BEFORE the slot start makes the
   * audible start land exactly on the slot start — and leaves every existing
   * resize calculation correct without touching it.
   */
  const geomFor = (cell: CellData, att: Att): TargetChipGeom | null => {
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
    return {
      anchor,
      start: slot.startSec,
      end: slot.startSec + slot.targetLenSec,
      trimStartSec,
      trimEndSec,
      durationSec,
      usingFallback: false,
    }
  }

  return {
    mode: "audioFirst",
    programme,
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
    chipSection: (cell, att) => {
      const slot = slotOf(cell)
      if (!slot) return null
      const geom = geomFor(cell, att)
      return {
        start: geom?.anchor ?? slot.startSec,
        end: slot.startSec + slot.slotLenSec,
      }
    },
    seekSecFor: (cell) => programme.byCellId.get(cell.id)?.startSec ?? null,
  }
}

/**
 * `cells` is everything on the file (for the track's extent); `dialogue` is
 * the time-sorted media lane from deriveLanes, which IS the programme's order.
 */
export function buildTimelineLayout(
  mode: AudioTimingMode,
  cells: readonly CellData[],
  dialogue: readonly CellData[],
): TimelineLayout {
  return mode === "audioFirst" ? audioFirstLayout(cells, dialogue) : dubbingLayout(cells)
}
