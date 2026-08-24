// Pure time<->pixel math + visibility windowing for the timeline editor.
export const ZOOM_MIN = 8
export const ZOOM_MAX = 240
export const ZOOM_DEFAULT = 38

export const secToPx = (sec: number, pxPerSec: number) => sec * pxPerSec
export const pxToSec = (px: number, pxPerSec: number) => px / pxPerSec

export function clampRange(startSec: number, endSec: number, minDurSec: number) {
  const s = Number.isFinite(startSec) ? Math.max(0, startSec) : 0
  let e = Number.isFinite(endSec) ? endSec : s
  if (e - s < minDurSec) e = s + minDurSec
  return { startSec: s, endSec: e }
}

export function isVisible(startSec: number, endSec: number, viewStartSec: number, viewEndSec: number) {
  return startSec < viewEndSec && viewStartSec < endSec
}

/** At or above this width a chip draws its full corner — normal zoom is here. */
export const CHIP_RADIUS_FULL_PX = 40
/** At or below this width a chip is dead square. */
export const CHIP_RADIUS_SQUARE_PX = 6

/**
 * The corner radius a chip of this width should draw. (AQU-646)
 *
 * WHY THIS EXISTS. Zoomed out, the source band read as a cue chip OVERLAPPING a
 * silence chip — one wall solid, one wall dashed. Nothing overlapped: the data
 * tiles exactly and so do the drawn boxes. The illusion is built entirely at
 * the shared walls. A 26px chip carrying an 8px corner spends a third of its
 * width on curves, so where a solid border meets a dashed one the two rounded
 * shapes read as interlocking rather than abutting — and because the corners
 * curve away from each other, the neighbour's dash peeks out past the solid
 * border exactly where a seam should be.
 *
 * So the corner does not merely get CLIPPED at narrow widths, it gets
 * PROGRESSIVELY SHARPER: a straight ramp from the full radius at 40px down to
 * square at 6px. The distinction matters and the first attempt got it wrong —
 * `min(max, width / 4)` holds the radius at a constant quarter of the width for
 * every chip below the cap, so a 26px chip and a 6px chip are proportionally
 * IDENTICAL and neither looks any squarer than the other. A ramp to zero makes
 * radius-over-width fall as the chip narrows, which is the thing that actually
 * stops small chips reading as lozenges.
 *
 * Normal zoom is untouched: at the default 38px/s anything from about a second
 * upward is past 40px and keeps exactly the corner it has today.
 *
 * CONTINUOUS, not stepped, on purpose: zoom is animated (TimelineEditor glides
 * pxPerSec), and a threshold would make every chip's corners pop mid-glide.
 */
export function chipRadiusPx(widthPx: number, maxPx = 8): number {
  if (!Number.isFinite(widthPx) || widthPx <= CHIP_RADIUS_SQUARE_PX) return 0
  if (widthPx >= CHIP_RADIUS_FULL_PX) return maxPx
  const t = (widthPx - CHIP_RADIUS_SQUARE_PX) / (CHIP_RADIUS_FULL_PX - CHIP_RADIUS_SQUARE_PX)
  return maxPx * t
}
