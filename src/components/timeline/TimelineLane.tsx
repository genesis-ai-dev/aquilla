// One horizontal track. Renders only the cards whose time range intersects the
// visible window (windowing for long files) and forwards select/retime.

import { isVisible } from "@/lib/timeline/scale"
import { TimelineCard } from "./TimelineCard"
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
  onSelect(id: string): void
  onRetime(id: string, startSec: number, endSec: number): void
}

export function TimelineLane({
  cells,
  variant,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  editable,
  onSelect,
  onRetime,
}: TimelineLaneProps) {
  const visible = cells.filter((c) =>
    isVisible(c.startTime ?? 0, c.endTime ?? c.startTime ?? 0, viewStartSec, viewEndSec),
  )
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
          onSelect={onSelect}
          onRetime={onRetime}
        />
      ))}
    </div>
  )
}
