// One horizontal track. Renders only the cards whose time range intersects the
// visible window (windowing for long files) and forwards select/retime.
//
// Round 6 (SUB-36): windows by each card's EFFECTIVE span (a subtitle card on
// a media cell may live far from its source section), computes per-card snap
// candidates (visible neighbors' edges + the cell's own frozen section edges),
// and carries the lane's `retimable` flag — the source row passes false.

import { isVisible } from "@/lib/timeline/scale"
import { subtitleSpanSec } from "@/lib/timeline/lane-timing"
import { TimelineCard, type TimelineVoiceControl } from "./TimelineCard"
import type { CellData } from "@/hooks/useCells"

export interface TimelineLaneProps {
  /** Already lane-filtered + time-sorted (from deriveLanes). */
  cells: CellData[]
  variant: "subtitle" | "dialogue"
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  editable: boolean
  /** Round 6: whether cards in this lane may be retimed at all. */
  retimable: boolean
  /** Round 6: edge snapping on/off (candidates are computed here). */
  snapEnabled?: boolean
  onSelect(id: string): void
  onRetime(id: string, startSec: number, endSec: number): void
  /** AQU-646: clean click on a card navigates playback to it. */
  onSeek?(id: string): void
  /** Round 6 (SUB-38): the dialogue lane's per-card voice picker wiring. */
  voiceControl?: TimelineVoiceControl
}

export function TimelineLane({
  cells,
  variant,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  editable,
  retimable,
  snapEnabled,
  onSelect,
  onRetime,
  onSeek,
  voiceControl,
}: TimelineLaneProps) {
  const spanOf = (c: CellData): { start: number; end: number } => {
    if (variant === "subtitle") {
      const s = subtitleSpanSec(c)
      if (s) return s
    }
    const start = c.startTime ?? 0
    return { start, end: c.endTime ?? start }
  }

  const visible = cells.filter((c) => {
    const s = spanOf(c)
    return isVisible(s.start, s.end, viewStartSec, viewEndSec)
  })

  // Snap candidates per card: every OTHER visible card's effective edges, plus
  // (for a media subtitle card) its own frozen section edges — dragging back
  // flush to the source split is the common "undo my accidental nudge".
  const candidatesFor = (cell: CellData): number[] => {
    if (!snapEnabled) return []
    const out: number[] = []
    for (const other of visible) {
      if (other.id === cell.id) continue
      const s = spanOf(other)
      out.push(s.start, s.end)
    }
    if (variant === "subtitle" && (cell.medium ?? "text") === "media") {
      if (typeof cell.startTime === "number" && Number.isFinite(cell.startTime)) out.push(cell.startTime)
      if (typeof cell.endTime === "number" && Number.isFinite(cell.endTime)) out.push(cell.endTime)
    }
    return out
  }

  return (
    <div data-testid="tl-lane" data-variant={variant} className="relative h-[66px] border-b border-border">
      {visible.map((c) => (
        <TimelineCard
          key={c.id}
          cell={c}
          pxPerSec={pxPerSec}
          laneStartSec={0}
          variant={variant}
          selected={selectedId === c.id}
          editable={editable}
          retimable={retimable}
          snap={retimable ? { enabled: Boolean(snapEnabled), candidates: candidatesFor(c) } : undefined}
          onSelect={onSelect}
          onRetime={onRetime}
          onSeek={onSeek}
          voiceControl={voiceControl}
        />
      ))}
    </div>
  )
}
