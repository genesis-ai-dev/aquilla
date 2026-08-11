// The Source-audio row for a subtitle file timed against footage. (AQU-646)
//
// Same chips as an imported recording's source row — literally the same
// component, TimelineCard in its dialogue variant — with the breaks falling at
// the VTT timestamps instead of at silence-detected splits. The stretches
// BETWEEN cues get a chip too: same shape, dashed, empty. That is the point of
// the row — the video has sound there, nobody has said anything about it yet,
// and a later round makes those chips fillable.
//
// 2026-08-11: this replaced a first draft that drew one continuous tinted band
// with hairline divisions. Sam: the app already has a chip language for "a
// stretch of source audio"; this row should look exactly like an mp3 import's,
// not invent its own.

import { memo } from "react"
import { secToPx, pxToSec, isVisible } from "@/lib/timeline/scale"
import { MIN_ADDABLE_SPAN_SEC } from "@/lib/timeline/lane-timing"
import { fmtClock } from "./format"
import { TimelineCard } from "./TimelineCard"
import type { CellData } from "@/hooks/useCells"
import type { SourceRegionMap } from "@/lib/timeline/source-regions"

// Silences shorter than MIN_ADDABLE_SPAN_SEC draw no chip. A real VTT carries
// 1–100ms rounding gaps between most consecutive cues, and a dashed sliver at
// every one reads as dirt — the space still shows, as the break between cards.
// Round 8: this is the same threshold that decides whether a line may be added
// there, so the row can never draw nothing over a stretch the pencil offers.

export interface SourceRegionLaneProps {
  map: SourceRegionMap
  /** Timed cells, lane-filtered + time-sorted (the subtitle derivation). */
  cells: CellData[]
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  editable: boolean
  onSelect(id: string): void
  /** Clean click on a cue chip → navigate playback to it (same as any lane). */
  onSeek?(id: string): void
  /** A click on a silence — seeks the transport to the clicked second. */
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
  const visibleGaps = map.regions.filter(
    (r) =>
      r.kind === "gap" &&
      r.endSec - r.startSec >= MIN_ADDABLE_SPAN_SEC &&
      isVisible(r.startSec, r.endSec, viewStartSec, viewEndSec),
  )

  return (
    <div data-testid="tl-source-regions" data-variant="source-band" className="relative h-[66px] border-b border-border">
      {visibleGaps.map((g) => (
        <div
          key={g.startSec}
          data-testid="tl-source-gap"
          data-region-start={g.startSec}
          data-region-end={g.endSec}
          title={`No subtitle here · ${(g.endSec - g.startSec).toFixed(1)}s`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            onSeekSec(g.startSec + pxToSec(e.clientX - rect.left, pxPerSec))
          }}
          // TimelineCard's geometry and radius, dashed and unfilled — the
          // established "slot with nothing in it yet" treatment (the untimed
          // strip's chips are the precedent), kept in the lane's sky family.
          className="absolute top-2.5 h-[46px] cursor-pointer overflow-hidden rounded-lg border border-dashed border-sky-300 bg-sky-50/30 transition-colors hover:bg-sky-100/40 dark:border-sky-900 dark:bg-sky-950/20 dark:hover:bg-sky-950/40"
          style={{
            left: `${secToPx(g.startSec, pxPerSec)}px`,
            width: `${secToPx(g.endSec - g.startSec, pxPerSec)}px`,
          }}
        >
          <span className="absolute bottom-1 left-2.5 font-mono text-[9px] tabular-nums text-muted-foreground">
            {fmtClock(g.startSec, true)}–{fmtClock(g.endSec, true)}
          </span>
        </div>
      ))}
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
