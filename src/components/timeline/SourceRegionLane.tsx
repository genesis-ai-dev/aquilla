// The Source-audio row: the AUDIO VTT's cues. (AQU-646, stage 2)
//
// Single-purpose now. Stage 1 pointed this component at the subtitle cells and
// called the result a band — the film's own audio, notionally divided at the
// text timestamps. Stage 2 killed that: the film's soundtrack gets no timeline
// row, ever (it is heard from the video pane whatever the timeline shows), and
// what this row draws instead is real DATA — a near-verbatim transcript of the
// film's speech, imported as a hidden sibling file and frozen. Where there is
// no cue, nobody spoke.
//
// Same chips as an imported recording's source row — literally the same
// component, TimelineCard in its dialogue variant, which reads
// `transcription || original` and so shows a cue's transcript with no change of
// its own. The stretches BETWEEN cues get a chip too: same shape, dashed,
// empty.
//
// 2026-08-11: this replaced a first draft that drew one continuous tinted band
// with hairline divisions. Sam: the app already has a chip language for "a
// stretch of source audio"; this row should look exactly like an mp3 import's,
// not invent its own.

import { memo } from "react"
import { secToPx, isVisible, chipRadiusPx } from "@/lib/timeline/scale"
import { MIN_ADDABLE_SPAN_SEC } from "@/lib/timeline/lane-timing"
import {
  MIN_CHIP_META_H_PX,
  TL_CHIP_BOX_CLASS,
  TL_ROW_H_CLASS,
} from "@/lib/timeline/row-metrics"
import { useRowMetrics } from "./useRowMetrics"
import { fmtClock } from "./format"
import { MIN_CARD_TEXT_PX, TimelineCard } from "./TimelineCard"
import type { CellData } from "@/hooks/useCells"
import type { SourceRegionMap } from "@/lib/timeline/source-regions"

// Silences shorter than MIN_ADDABLE_SPAN_SEC draw no chip. A real VTT carries
// 1–100ms rounding gaps between most consecutive cues, and a dashed sliver at
// every one reads as dirt — the space still shows, as the break between cards.
// Round 8 shared this number with the "may a line be added here" rule so the
// row could never stay silent about a stretch the pencil offered. Stage 2 keeps
// the number and drops that guarantee, deliberately: the pencil is offered over
// the TEXT cues' gaps and this row draws the AUDIO cues' gaps, which are a
// different set of boundaries. One threshold for "too narrow to say anything
// about", applied to two different questions.

export interface SourceRegionLaneProps {
  map: SourceRegionMap
  /** The audio-cue sibling's cells, in cue order. Empty is legal (no import
   *  yet) and draws an empty row rather than crashing. */
  cells: CellData[]
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  editable: boolean
  onSelect(id: string): void
  /** Clean click on a cue chip → navigate playback to it (same as any lane). */
  onSeek?(id: string): void
  /**
   * A click on a silence. Round 8: it reports the silence's START, not wherever
   * the pointer happened to land. Clicking a stretch that means "nothing is
   * said here" and being dropped at an arbitrary point inside it told you
   * nothing; the beginning of the silence is the only second in it worth
   * naming, and it is where you would start listening.
   */
  onSeekSec(sec: number): void
}

function SourceRegionLaneImpl({
  map,
  cells,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  editable,
  onSelect,
  onSeek,
  onSeekSec,
}: SourceRegionLaneProps) {
  const spanOf = (c: CellData): { start: number; end: number } => {
    const start = c.startTime ?? 0
    return { start, end: c.endTime ?? start }
  }
  const visibleCells = cells.filter((c) => {
    const s = spanOf(c)
    return isVisible(s.start, s.end, viewStartSec, viewEndSec)
  })
  const { chipH } = useRowMetrics()
  const visibleGaps = map.regions.filter(
    (r) =>
      r.kind === "gap" &&
      r.endSec - r.startSec >= MIN_ADDABLE_SPAN_SEC &&
      isVisible(r.startSec, r.endSec, viewStartSec, viewEndSec),
  )

  return (
    <div data-testid="tl-source-regions" data-variant="source-audio-cues" className={`relative ${TL_ROW_H_CLASS} border-b border-border`}>
      {visibleGaps.map((g) => {
        const widthPx = secToPx(g.endSec - g.startSec, pxPerSec)
        return (
        <div
          key={g.startSec}
          data-testid="tl-source-gap"
          data-region-start={g.startSec}
          data-region-end={g.endSec}
          // "No speech", not "no subtitle": these gaps come from a transcript of
          // the soundtrack, so a gap says nobody was talking — a subtitle may
          // well exist over it, and often does.
          title={`No speech here · ${(g.endSec - g.startSec).toFixed(1)}s`}
          onClick={() => onSeekSec(g.startSec)}
          // TimelineCard's geometry and radius, dashed and unfilled — the
          // established "slot with nothing in it yet" treatment (the untimed
          // strip's chips are the precedent), kept in the lane's sky family.
          className={`absolute ${TL_CHIP_BOX_CLASS} cursor-pointer overflow-hidden border border-dashed border-sky-300 bg-sky-50/30 transition-colors hover:bg-sky-100/40 dark:border-sky-900 dark:bg-sky-950/20 dark:hover:bg-sky-950/40`}
          // The radius shrinks with the chip. A narrow silence flush against a
          // solid-walled cue is exactly where the two used to read as one
          // interlocked shape.
          style={{
            left: `${secToPx(g.startSec, pxPerSec)}px`,
            width: `${widthPx}px`,
            borderRadius: `${chipRadiusPx(widthPx)}px`,
          }}
        >
          {/* Round 9: only when there is room for it, and never wrapping.
              This label is absolutely positioned with no right anchor, so at a
              narrow width it shrink-to-fits, WRAPS onto two or three lines, and
              the `bottom-1` anchor pushes those lines up out of the 46px chip
              where overflow-hidden slices them mid-glyph. Fully zoomed out that
              read as time ranges bleeding across neighbouring chips. Same
              threshold as a card's own text — one number for "is there room
              to say anything here", across every chip on the timeline.
              Stage 3: a short chip is that identical failure on the other axis
              — the same 9px line, the same `bottom-1` anchor, the same
              overflow-hidden slicing it — so it goes at the same height a
              card's own timecode does. */}
          {widthPx >= MIN_CARD_TEXT_PX && chipH >= MIN_CHIP_META_H_PX && (
            <span className="absolute bottom-1 left-2.5 font-mono text-[9px] tabular-nums whitespace-nowrap text-muted-foreground">
              {fmtClock(g.startSec, true)}–{fmtClock(g.endSec, true)}
            </span>
          )}
        </div>
        )
      })}
      {visibleCells.map((c) => (
        <TimelineCard
          key={c.id}
          cell={c}
          pxPerSec={pxPerSec}
          laneStartSec={0}
          variant="dialogue"
          selected={selectedId === c.id}
          editable={editable}
          // The split is the VTT's; this row does not edit it. Same rule as an
          // imported recording's source row (frozen at import).
          retimable={false}
          span={spanOf(c)}
          onSelect={onSelect}
          onRetime={() => {}}
          onSeek={onSeek}
        />
      ))}
    </div>
  )
}

export const SourceRegionLane = memo(SourceRegionLaneImpl)
