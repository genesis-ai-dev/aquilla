// The [start,end] playback window (seconds) the per-cell player (useCellAudio)
// must honor for a cell. This is the single rule shared by the local per-cell
// player and the global play-queue (which uses `trimWindowForCell`): an
// imported audio/video FILE is split into N media segments that all share ONE
// clip, each windowed by [startTime,endTime). Ignoring that window streams the
// shared clip from 0:00, so every section sounds like the file's opening
// (AQU-647).

import { trimWindowForCell } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

export interface CropBounds {
  start: number | null
  end: number | null
}

/**
 * Combine a cell's imported media-segment window with any manual crop:
 * - **Media segment** (`medium: "media"` with a valid [startTime,endTime)):
 *   the section window is the base constraint; a manual crop narrows further
 *   WITHIN it (clamped to the section, so a stale/oversized crop can never
 *   widen playback past the section boundary).
 * - **Ordinary cell** (own recording / generated voice): no section window, so
 *   the manual crop alone applies — byte-identical to the pre-AQU-647 behavior.
 */
export function cellPlaybackWindow(cell: CellData, crop: CropBounds): CropBounds {
  const media = trimWindowForCell(cell)
  if (!media) return { start: crop.start, end: crop.end }
  return {
    start: Math.max(media.start, crop.start ?? media.start),
    end: Math.min(media.end, crop.end ?? media.end),
  }
}
