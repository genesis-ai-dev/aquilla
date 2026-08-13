// One horizontal track. Renders only the cards whose time range intersects the
// visible window (windowing for long files) and forwards select/retime.
//
// Round 6 (SUB-36): windows by each card's EFFECTIVE span (a subtitle card on
// a media cell may live far from its source section), computes per-card snap
// candidates (visible neighbors' edges + the cell's own frozen section edges),
// and carries the lane's `retimable` flag — the source row passes false.

import { Pencil } from "lucide-react"
import { isVisible } from "@/lib/timeline/scale"
import {
  MIN_SLOT_BUTTON_H_PX,
  TL_CHIP_BOX_CLASS,
  TL_ROW_H_CLASS,
} from "@/lib/timeline/row-metrics"
import { useRowMetrics } from "./useRowMetrics"
import { TimelineSlotButton } from "./TimelineSlotButton"
import { MIN_SLOT_PX, useHotSlot } from "./slot-hover"
import { subtitleSpanSec } from "@/lib/timeline/lane-timing"
import { TimelineCard } from "./TimelineCard"
import type { TimelineLayout } from "@/lib/timeline/layout"
import type { CellData } from "@/hooks/useCells"

export interface TimelineLaneProps {
  /** Already lane-filtered + time-sorted (from deriveLanes). */
  cells: CellData[]
  /** AQU-646 stage 2: "target-subtitle" draws the same cells as "subtitle" with
   *  their translation on the chip — a third variant so the row is
   *  distinguishable in the DOM, and so TimelineCard keeps the text policy. */
  variant: "subtitle" | "dialogue" | "target-subtitle"
  /** SUB-53: resolves where each card sits — the frozen file clock in dubbing
   *  mode, the laid-out programme in audio-first. Absent = dubbing. */
  layout?: TimelineLayout
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  editable: boolean
  /** Round 6: whether cards in this lane may be retimed at all. */
  retimable: boolean
  /** AQU-646 round 8: per-CARD veto on top of `retimable`, shaped like
   *  `canRemove` below. Absent = every card in the lane may move, which is what
   *  every caller but the VTT-plus-footage arrangement wants. */
  canRetimeCell?(cell: CellData): boolean
  /** Round 6: edge snapping on/off (candidates are computed here). */
  snapEnabled?: boolean
  /** AQU-646 round 8: hold every card inside its neighbours' edges. Off by
   *  default — SUB-36's media-subtitle card is deliberately free to sit
   *  anywhere, and an always-on bound would silently cage it. */
  boundNeighbours?: boolean
  onSelect(id: string): void
  onRetime(id: string, startSec: number, endSec: number): void
  /** AQU-646: clean click on a card navigates playback to it. */
  onSeek?(id: string): void
  /** AQU-646: stretches with no cell of their own, where a line could be added.
   *  Only the VTT-plus-footage arrangement passes these. */
  emptySpans?: readonly { startSec: number; endSec: number }[]
  /** Clicking the "add a line" button over one of those stretches. */
  onAddLine?(startSec: number, endSec: number): void
  /** Take back a line. The lane decides nothing — it asks this per cell. */
  canRemove?(cell: CellData): boolean
  onRemove?(cellId: string): void
}

export function TimelineLane({
  cells,
  variant,
  layout,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  editable,
  retimable,
  canRetimeCell,
  snapEnabled,
  boundNeighbours,
  onSelect,
  onRetime,
  onSeek,
  emptySpans,
  onAddLine,
  canRemove,
  onRemove,
}: TimelineLaneProps) {
  // Which add-line slot the pointer is on. State rather than CSS `:hover` —
  // see TimelineSlotButton's header for the six-lit-at-once bug that forced it.
  const { hotKey, slotHoverProps } = useHotSlot(viewStartSec, pxPerSec)
  // AQU-646 stage 3: the pencil is an `h-7` circle inside a slot with no
  // overflow-hidden, so on a short row it draws straight over the lanes above
  // and below and can be clicked from either of them. It is hover-only anyway,
  // so dropping it at compact heights costs a user nothing — the row is a
  // colour band at that point, not a place anyone is editing from.
  const { chipH } = useRowMetrics()
  const showsSlotButton = chipH >= MIN_SLOT_BUTTON_H_PX

  const spanOf = (c: CellData): { start: number; end: number } => {
    if (layout) {
      // Only the dialogue row asks for the SOURCE span (a media cell's frozen
      // section). Both subtitle-shaped rows sit on the subtitle span, because a
      // translation is drawn at the timing of the cue it translates.
      const s = layout.spanFor(c, variant === "dialogue" ? "source" : "subtitle")
      if (s) return s
    }
    if (variant === "subtitle") {
      const s = subtitleSpanSec(c)
      if (s) return s
    }
    const start = c.startTime ?? 0
    return { start, end: c.endTime ?? start }
  }

  // AQU-646 round 8: the walls each card may not cross, derived from the WHOLE
  // lane before any windowing. Deriving them from `visible` would look natural
  // — that is where the snap candidates come from — but `visible` is a window
  // with about 240px of overscan, so a neighbour scrolled off-screen would
  // silently stop constraining the drag and the card would sail through it.
  //
  // The floor is a running maximum of every END so far, not the previous card's
  // end: `cells` arrives sorted by START, and a real VTT may contain overlapping
  // cues, so a long cue can reach past several shorter ones after it.
  const boundsById = new Map<string, { minStartSec: number; maxEndSec: number }>()
  if (boundNeighbours) {
    let maxEndBefore = 0
    for (let i = 0; i < cells.length; i++) {
      boundsById.set(cells[i].id, {
        minStartSec: maxEndBefore,
        maxEndSec: i + 1 < cells.length ? spanOf(cells[i + 1]).start : Number.POSITIVE_INFINITY,
      })
      maxEndBefore = Math.max(maxEndBefore, spanOf(cells[i]).end)
    }
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

  // AQU-646: "there is room for a line here". Faint at rest rather than
  // invisible (Sam, 2026-08-11) so the affordance can be found without hunting
  // for it, and gone entirely when the stretch is too narrow to hold a button.
  const addLine = onAddLine
  const addSlots =
    editable && addLine
      ? (emptySpans ?? [])
          .filter((s) => isVisible(s.startSec, s.endSec, viewStartSec, viewEndSec))
          .map((s) => ({
            span: s,
            leftPx: s.startSec * pxPerSec,
            widthPx: (s.endSec - s.startSec) * pxPerSec,
          }))
          .filter((s) => s.widthPx >= MIN_SLOT_PX)
      : []

  return (
    <div data-testid="tl-lane" data-variant={variant} className={`relative ${TL_ROW_H_CLASS} border-b border-border`}>
      {addSlots.map(({ span, leftPx, widthPx }) => (
        <div
          key={`add-${span.startSec}`}
          data-testid={`tl-add-line-${span.startSec}`}
          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
          className={`absolute ${TL_CHIP_BOX_CLASS} flex items-center justify-center`}
          {...slotHoverProps(String(span.startSec))}
        >
          {showsSlotButton && (
            <TimelineSlotButton
              testId={`tl-add-line-${span.startSec}-button`}
              label="Add a line here"
              hot={hotKey === String(span.startSec)}
              onClick={() => addLine?.(span.startSec, span.endSec)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </TimelineSlotButton>
          )}
        </div>
      ))}
      {visible.map((c) => {
        // An AND, never a replacement: the lane-wide flag still has the last
        // word, so a lane that was frozen (SUB-53's re-flowed track) cannot be
        // thawed by a permissive per-cell predicate.
        const cardRetimable = retimable && (canRetimeCell?.(c) ?? true)
        return (
        <TimelineCard
          key={c.id}
          cell={c}
          pxPerSec={pxPerSec}
          laneStartSec={0}
          variant={variant}
          selected={selectedId === c.id}
          editable={editable}
          retimable={cardRetimable}
          span={spanOf(c)}
          bounds={boundsById.get(c.id)}
          snap={cardRetimable ? { enabled: Boolean(snapEnabled), candidates: candidatesFor(c) } : undefined}
          onSelect={onSelect}
          onRetime={onRetime}
          onSeek={onSeek}
          onRemove={onRemove && canRemove?.(c) ? onRemove : undefined}
        />
        )
      })}
    </div>
  )
}
