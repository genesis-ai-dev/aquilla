// AQU-646: DAW-style follow-playhead scrolling. Page-flip rather than smooth
// centering — continuous centering would scroll (and re-render the editor)
// every frame, while a page-flip scrolls only when the playhead approaches the
// viewport edge, landing it near the left so a full page of upcoming material
// is visible (the Logic/Pro Tools convention).

/** Playhead position past this fraction of the viewport triggers a flip. */
const FLIP_AT = 0.85
/** After a flip the playhead sits at this fraction from the viewport's left. */
const LAND_AT = 0.1

/**
 * The scrollLeft to apply so the playhead stays followable, or null when no
 * scroll is needed. Also flips when the playhead is off-screen LEFT (a seek
 * backwards). Clamps to the scrollable range.
 */
export function computeFollowScroll(
  playheadPx: number,
  scrollLeft: number,
  viewportPx: number,
  trackPx: number,
): number | null {
  if (viewportPx <= 0) return null
  const rel = playheadPx - scrollLeft
  if (rel >= 0 && rel < viewportPx * FLIP_AT) return null
  const maxScroll = Math.max(0, trackPx - viewportPx)
  const target = Math.max(0, Math.min(playheadPx - viewportPx * LAND_AT, maxScroll))
  return Math.round(target) === Math.round(scrollLeft) ? null : target
}
