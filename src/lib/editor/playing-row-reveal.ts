// AQU-1636: when a row's audio starts sounding, the editor table brings that
// row into view. Two pure decisions sit behind that, and getting either wrong
// is what the reported "weird scroll behaviour" was made of.
//
// 1. WHEN is a start? The row list is virtualized with recycled, estimated
//    row heights, so a row whose clip is already playing mounts and unmounts
//    freely as the user scrolls. A per-mount "was it playing last render?"
//    flag starts life `false`, so every such mount read as a fresh start and
//    scrolled the list back onto the playing row — the user could not scroll
//    away from it while it played. A start is a false → true transition that
//    THIS row actually observed; the first observation of a row's state is
//    not a transition at all.
//
// 2. DOES the row need revealing? The list scrolls inside its own container,
//    not the window, and a row can be taller than that container (an expanded
//    cell on a transcribed media file). Measuring "fully visible" against the
//    window made a row the user was already looking at count as off-screen,
//    so pressing Play scrolled the page for no reason.

/** Nothing observed yet for this row (a fresh mount), or its last state. */
export type SeenPlaying = boolean | null

/**
 * True only for a false → true transition this row observed itself.
 *
 * `previous === null` is a row that has only just mounted: it may well be
 * showing a clip that has been sounding for a while, and that is not a start.
 */
export function isPlaybackStart(previous: SeenPlaying, playing: boolean): boolean {
  return previous === false && playing
}

export interface VerticalBox {
  top: number
  bottom: number
}

/**
 * True when the row is not already readable inside the list viewport.
 *
 * A row is readable when it lies wholly inside the viewport, and also when it
 * is taller than the viewport and covers it — scrolling a row that already
 * fills the screen only moves text out from under the reader.
 */
export function rowNeedsReveal(row: VerticalBox, viewport: VerticalBox): boolean {
  const whollyInside = row.top >= viewport.top && row.bottom <= viewport.bottom
  const coversViewport = row.top <= viewport.top && row.bottom >= viewport.bottom
  return !whollyInside && !coversViewport
}
