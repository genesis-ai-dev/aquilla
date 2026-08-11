// The Source-audio row for a subtitle file timed against footage: the video's
// own audio, drawn as ONE continuous span with a division at every subtitle
// timestamp. (AQU-646)
//
// Deliberately NOT TimelineCard. That component draws a rounded, bordered,
// individually-filled box — which is exactly the "lots of separate clips"
// impression this row must not give, because the audio is not clips. It is one
// piece that has been marked up. (It is also 271 lines of drag state, resize
// grips and per-card pointer listeners, against a file that produces a couple
// of thousand regions; but the drawing is the reason.)
//
// So: one bar underneath for continuity, one rectangle per region on top. The
// stretches a subtitle covers are tinted, the silences are left plain, and the
// left border of each rectangle IS the division mark. Nothing here is
// draggable — the split is the VTT's, and this row does not edit it.

import { memo } from "react"
import { cn } from "@/lib/utils"
import { secToPx, pxToSec, isVisible } from "@/lib/timeline/scale"
import type { SourceRegion, SourceRegionMap } from "@/lib/timeline/source-regions"

export interface SourceRegionLaneProps {
  map: SourceRegionMap
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  /** Clicking anywhere on the band moves the playhead there. */
  onSeek(sec: number): void
}

function describe(region: SourceRegion): string {
  const len = `${(region.endSec - region.startSec).toFixed(1)}s`
  if (region.kind === "gap") return `No subtitle here · ${len}`
  if (region.kind === "overlap") return `${region.cellIds.length} lines at once · ${len}`
  return `Subtitle · ${len}`
}

function SourceRegionLaneImpl({
  map,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  onSeek,
}: SourceRegionLaneProps) {
  const visible = map.regions.filter((r) => isVisible(r.startSec, r.endSec, viewStartSec, viewEndSec))

  return (
    <div
      data-testid="tl-source-regions"
      data-variant="source-band"
      className="relative h-[66px] border-b border-border"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, pxToSec(e.clientX - rect.left, pxPerSec)))
      }}
    >
      {/* The continuity: one unbroken piece of audio running the whole length
          of the footage, including past the last cue. */}
      <div
        data-testid="tl-source-band"
        className="absolute top-2.5 h-[46px] rounded-md border border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/40"
        style={{ left: 0, width: `${secToPx(map.totalSec, pxPerSec)}px` }}
      />
      {visible.map((r) => (
        <div
          key={r.startSec}
          data-testid={`tl-source-region-${r.kind}`}
          data-region-start={r.startSec}
          data-region-end={r.endSec}
          title={describe(r)}
          className={cn(
            "absolute top-2.5 h-[46px]",
            // The left edge is the division mark — one rule per timestamp,
            // drawn by the region that starts there.
            r.startSec > 0 && "border-l border-sky-300/80 dark:border-sky-800",
            r.kind === "cue" && "bg-sky-200/60 dark:bg-sky-900/50",
            // Two speakers at once. Almost always the import's own doing, and
            // there is currently no other way to see that it happened.
            r.kind === "overlap" && "bg-amber-200/70 dark:bg-amber-900/50",
          )}
          style={{
            left: `${secToPx(r.startSec, pxPerSec)}px`,
            width: `${secToPx(r.endSec - r.startSec, pxPerSec)}px`,
          }}
        />
      ))}
    </div>
  )
}

export const SourceRegionLane = memo(SourceRegionLaneImpl)
