// AQU-2432 (Sam, Nov 9, rule 8): THE MARKER for a line with too little room.
//
// Following the recordings, a line nobody has recorded can have its room
// closed, down to nothing, by dragging the next take earlier against it. A
// line with no room has no width, so its usual dashed box cannot be drawn.
// This is what is drawn instead, so it is always possible to see that a line
// sits there: a thin dashed line the full height of the row, at the seam, with
// a small dashed tab at the row's top edge.
//
// THE LOOK IS THE APP'S DASHED PLACEHOLDER (`TRACK_DASH_CLASS`): the same
// dash, in the row's own hue, filling under the pointer. No new colour, and
// no pill, badge or chip.
//
// IT NEVER MOVES ITS NEIGHBOURS. It is laid over them, and only the TAB
// answers the pointer: the tab lives in the band above the takes (the row's
// own top padding), so it covers no take, no trim handle and no red overlap
// mark; the line through the row lets clicks and drags through to the takes.
//
// Which lines get one, and where, is lib/timeline/line-markers.

import { AppTooltip } from "@/components/ui/tooltip"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"
import { LINE_MARKER_TAB_PX, type EmptyLineMarkerSpec } from "@/lib/timeline/line-markers"
// AQU-2432 (review, Nov 9): under it a room is none, here and in the layout.
import { MIN_ROOM_SEC } from "@/lib/timeline/line-room"
import { TRACK_DASH_CLASS } from "@/lib/timeline/track-colors"
import { parseScriptureReference } from "@/lib/scripture-reference"
import { cn } from "@/lib/utils"


/** What the marker calls its line: its own label, its reference, else its
 *  number among the timeline's lines. */
export function markerLineName(
  cell: Pick<CellData, "cellLabel" | "group" | "globalReferences">,
  position: number,
  t: ReturnType<typeof useT>,
): string {
  const label = cell.cellLabel?.trim()
  if (label) return label
  const ref = parseScriptureReference(cell.group) ?? parseScriptureReference(cell.globalReferences?.[0])
  if (ref?.verse) return `${ref.bookName} ${ref.chapter}:${ref.verse}`
  return t("editor.row.lineAria", { number: position })
}

export function EmptyLineMarker({
  marker,
  selected,
  onSelect,
  onSeek,
  zIndex = 10,
}: {
  marker: EmptyLineMarkerSpec
  selected: boolean
  /** Its place in its row's paint order: over its neighbours at rest. A text
   *  row's boxes come forward at 10 (the default: the marker is later in the
   *  row, so it wins the tie); the takes row hands in one above its takes. */
  zIndex?: number
  /** Select the line, exactly as clicking its box would. */
  onSelect(cellId: string): void
  /** Take the playhead to the line, as a click on its box does. */
  onSeek?(cellId: string): void
}) {
  const t = useT()
  const { cell, atPx, tabLeftPx, roomSec, position } = marker
  const line = markerLineName(cell, position, t)
  const says = roomSec < MIN_ROOM_SEC
    ? t("editor.timeline.lineMarkerNoRoom", { line })
    : t("editor.timeline.lineMarkerNarrowRoom", { line, seconds: roomSec.toFixed(1) })
  return (
    <div
      data-testid={`tl-line-marker-${cell.id}`}
      data-selected={selected ? "true" : undefined}
      // Over its neighbours either side (a hovered or dragged take still
      // comes in front of it), and never in their way: see the header.
      className="pointer-events-none absolute inset-y-0"
      style={{ left: `${tabLeftPx}px`, width: `${LINE_MARKER_TAB_PX}px`, zIndex }}
    >
      <span
        aria-hidden
        data-testid={`tl-line-marker-${cell.id}-line`}
        className={cn(
          "absolute inset-y-0 w-0 border-l border-dashed border-[color:var(--tl-track-hue)]",
          selected && "border-sky-500",
        )}
        // On the line's own place, wherever its tab had to sit.
        style={{ left: `${atPx - tabLeftPx}px` }}
      />
      <AppTooltip content={says} side="top">
        <button
          type="button"
          data-testid={`tl-line-marker-${cell.id}-tab`}
          aria-label={says}
          // Space plays, as it does on a line's box; Enter selects.
          data-spacebar-transport=""
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(cell.id)
            onSeek?.(cell.id)
          }}
          onContextMenu={(e) => {
            // The row behind it is the TRACK's menu; this is not the track.
            e.preventDefault()
            e.stopPropagation()
          }}
          className={cn(
            "pointer-events-auto absolute inset-x-0 top-0 h-[var(--tl-chip-top,10px)] min-h-[6px] cursor-pointer rounded-b-[3px] border bg-background transition-colors",
            TRACK_DASH_CLASS,
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500",
            selected && "ring-2 ring-sky-500",
          )}
        />
      </AppTooltip>
    </div>
  )
}
