/**
 * AQU-2467: the geometry behind the Report a problem crop view.
 *
 * The user drags a box over the screenshot as it is drawn on screen (CSS
 * pixels, scaled to fit the dialog). The crop has to cut the full-resolution
 * image (natural pixels), so the mapping lives here, free of React and the DOM,
 * where it can be tested.
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

/** A drag shorter than this on either edge is a stray click, not a selection. */
export const MIN_CROP_EDGE_PX = 8

/** The box spanned by two corners, kept inside the displayed image whichever
 *  way the user dragged. */
export function boxFromDrag(start: Point, end: Point, bounds: Size): Rect {
  const clampX = (v: number) => Math.min(Math.max(v, 0), bounds.width)
  const clampY = (v: number) => Math.min(Math.max(v, 0), bounds.height)
  const x1 = clampX(start.x)
  const y1 = clampY(start.y)
  const x2 = clampX(end.x)
  const y2 = clampY(end.y)
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

export function isUsableBox(box: Rect | null): box is Rect {
  return box !== null && box.width >= MIN_CROP_EDGE_PX && box.height >= MIN_CROP_EDGE_PX
}

/** Map a box drawn on the displayed image to pixels of the natural image.
 *  Rounded outward-safe: always at least 1 px and never past the image edge. */
export function displayBoxToNaturalRect(box: Rect, display: Size, natural: Size): Rect {
  if (display.width <= 0 || display.height <= 0) {
    return { x: 0, y: 0, width: natural.width, height: natural.height }
  }
  const sx = natural.width / display.width
  const sy = natural.height / display.height
  const x = Math.min(Math.max(Math.round(box.x * sx), 0), natural.width - 1)
  const y = Math.min(Math.max(Math.round(box.y * sy), 0), natural.height - 1)
  const width = Math.min(Math.max(Math.round(box.width * sx), 1), natural.width - x)
  const height = Math.min(Math.max(Math.round(box.height * sy), 1), natural.height - y)
  return { x, y, width, height }
}
