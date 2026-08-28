// AQU-646 stage 2: a folder's own lane.
//
// Open, it holds nothing — the tracks inside are rows of their own directly
// beneath it, and the folder row is just their heading.
//
// Closed, it shows the Logic-style summary: a compressed picture of where there
// is material on the tracks it is hiding, so closing a folder loses the detail
// without losing the shape. That is the whole argument for folding a stack up
// rather than deleting it.
//
// THE ROW IS RENDERED EITHER WAY, EMPTY OR NOT. The gutter and the lanes are
// matched row for row, and a folder that drew no lane would shift every row
// below it out of line with its own label — and take `beginTrackDrag`'s
// hit-testing with it, silently.

import { folderRowHPx } from "@/lib/timeline/row-metrics"
import { secToPx } from "@/lib/timeline/scale"
import { summaryBlocks, type SummarySpan } from "@/lib/timeline/summary-band"
import { useRowMetrics } from "./useRowMetrics"

export function TimelineFolderLane({
  trackId,
  collapsed,
  spans,
  pxPerSec,
  viewStartSec,
  viewEndSec,
}: {
  trackId: string
  collapsed: boolean
  /** Every span on every track inside, concatenated. Coalescing and culling
   *  are `summaryBlocks`' job, not the caller's. */
  spans: readonly SummarySpan[]
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
}) {
  const blocks = collapsed ? summaryBlocks(spans, { viewStartSec, viewEndSec, pxPerSec }) : []
  // AQU-646 stage 4b: a slim fixed heading, NOT `TL_ROW_H_CLASS`. An inline
  // style rather than a class because the height is min(28, dial) — dynamic —
  // and it MUST match the gutter's folder row byte for byte: the two columns
  // are matched row for row (see the header comment), so LaneLabel computes
  // the same `folderRowHPx` on its side.
  const { rowH } = useRowMetrics()
  return (
    <div
      data-testid={`tl-folder-lane-${trackId}`}
      data-collapsed={collapsed ? "" : undefined}
      // 2026-08-27 (Sam): the folder row is a GREY BAND across both columns —
      // this is its lane half, the same opaque token the gutter's folder row
      // wears, so the band reads as one strip with no seam at the column edge
      // (the gutter's edge rule is covered on that side; see its comment).
      //
      // ITS OWN TOKEN, not `bg-muted`: in dark, `--muted` is defined to exactly
      // `--surface`, which is also `--background` — so the band was the page
      // ground and simply did not exist there, while still covering its 1px of
      // the divider and leaving a gap in it.
      className="relative border-b border-border bg-[color:var(--tl-folder-band)]"
      style={{ height: `${folderRowHPx(rowH)}px` }}
    >
      {blocks.map((block) => (
        <div
          key={block.startSec}
          aria-hidden
          // Muted and thin, deliberately: this is a stand-in for rows the
          // person has said they are not looking at, so it must read as less
          // than any real chip beside it. Vertically centred rather than
          // filling the row, which is what stops a closed folder looking like
          // one enormous take.
          className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-muted-foreground/40"
          style={{
            left: `${secToPx(block.startSec, pxPerSec)}px`,
            // A block narrower than a pixel still has to be visible — at a zoom
            // where the whole file fits, a single short take is the only thing
            // on the row and rounding it to nothing would say the folder is
            // empty.
            width: `${Math.max(2, secToPx(block.endSec - block.startSec, pxPerSec))}px`,
          }}
        />
      ))}
    </div>
  )
}
