// Where the picture actually sits inside the video pane's black field.
// (AQU-646, 2026-08-08)
//
// The pane fills its whole height with black and centres the picture in it at the
// video's own proportions, so unused space reads as cinema bars rather than blank
// page. That much a browser will do on its own — `object-contain` letterboxes a
// video perfectly well.
//
// What it will NOT do is tell you WHERE it put the picture, and we need that: the
// burned-in caption has to anchor to the picture's own bottom edge, or it drifts
// into a black bar as the pane is resized. There is no CSS route to both effects
// at once — a replaced element sized by `max-width`/`max-height` keeps its ratio
// but exposes no box to position against, and `aspect-ratio` quietly yields the
// ratio as soon as one of the maxima binds. So the rect is computed here, in a
// pure function, and the picture layer is sized in real pixels.

export interface PictureRect {
  width: number
  height: number
}

/**
 * The largest box of ratio `aspect` that fits inside `containerW` × `containerH`.
 *
 * Returns null when the inputs cannot describe a real box — a container that has
 * not been laid out yet, or a video whose dimensions are not known. The caller
 * falls back to a plain aspect-ratio box rather than rendering something 0×0 or
 * NaN-sized. That path is load-bearing in tests: happy-dom has no layout engine,
 * so every measurement there is 0.
 */
export function fitPictureRect(
  containerW: number,
  containerH: number,
  aspect: number,
): PictureRect | null {
  if (![containerW, containerH, aspect].every((n) => Number.isFinite(n) && n > 0)) return null
  // Width-bound (bars top and bottom) vs height-bound (bars left and right).
  const height = Math.min(containerH, containerW / aspect)
  const width = height * aspect
  if (!(width > 0 && height > 0)) return null
  return { width, height }
}

/** 16:9 until the element reports its real dimensions — the overwhelmingly common
 *  shape, so the first paint is almost never wrong, and never wildly so. */
export const DEFAULT_VIDEO_ASPECT = 16 / 9

/** Intrinsic ratio of a loaded video, or null while it is still unknown. */
export function intrinsicAspect(videoWidth: number, videoHeight: number): number | null {
  if (!(Number.isFinite(videoWidth) && Number.isFinite(videoHeight))) return null
  if (!(videoWidth > 0 && videoHeight > 0)) return null
  return videoWidth / videoHeight
}
