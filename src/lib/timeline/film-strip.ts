// The film track's geometry (AQU-2253, canvas board 56). Pure, so the board's
// numbers can be pinned by tests.
//
// The film is one strip on its own clock: it starts at 0:00 and ends where the
// film ends, at the timeline's zoom, in both timings. Following the recordings
// it does not stretch, chop or adjust to the lines; they simply start together.
//
// Across its top runs an old-school perforated border (Sam, Oct 29: "only a top
// film track border", 10 px), and below it the film's own frames tile along
// the strip, one picture per tile, each showing the moment at its middle.

/** Decided Oct 29: the sprocket band along the top is 10 px (board 56's `BAND['top']`). */
export const FILM_SPROCKET_BAND_PX = 10

/** The strip's own black, the band's and the frames' backing (board 56). */
export const FILM_STRIP_COLOR = "#141518"

/** The strip's corner radius (board 56). */
export const FILM_STRIP_RADIUS_PX = 5

/**
 * The board's tile: 58 px wide over a 36 px picture (a 46 px chip less the
 * 10 px band). A shorter or taller row keeps the tile's shape, so the frames
 * keep theirs.
 */
const BOARD_TILE_W = 58
const BOARD_PICTURE_H = 36
/** Below this a tile shows too little of a frame to be worth fetching. */
const MIN_TILE_W = 16

/** The perforations, as board 56's `sprockets()` draws them: light rounded
 *  holes on the film's black, growing with the band. */
export interface SprocketGeometry {
  /** One hole and the gap after it. */
  pitch: number
  holeW: number
  holeH: number
  /** Where the hole sits inside its pitch. */
  holeX: number
  holeY: number
  radius: number
}

export function sprocketGeometry(bandPx: number): SprocketGeometry {
  const h = Math.max(0, bandPx)
  const holeW = Math.max(3, h * 0.57)
  const holeH = Math.max(2, h * 0.43)
  const pitch = Math.max(8, h * 1.29)
  return {
    pitch,
    holeW,
    holeH,
    holeX: (pitch - holeW) / 2,
    holeY: (h - holeH) / 2,
    radius: Math.max(0.8, holeH * 0.3),
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * One pitch of perforation as an SVG, to repeat along the band as a CSS
 * background. A background rather than one SVG the strip's width: an
 * hour-long film at full zoom is hundreds of thousands of pixels wide.
 */
export function sprocketTileSvg(bandPx: number): string {
  const g = sprocketGeometry(bandPx)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r1(g.pitch)}" height="${bandPx}" viewBox="0 0 ${r1(g.pitch)} ${bandPx}">` +
    `<rect x="${r1(g.holeX)}" y="${r1(g.holeY)}" width="${r1(g.holeW)}" height="${r1(g.holeH)}" rx="${r1(g.radius)}" fill="#e7e8ea" fill-opacity="0.92"/>` +
    `</svg>`
  )
}

export function sprocketBackground(bandPx: number): { backgroundImage: string; backgroundSize: string } {
  const g = sprocketGeometry(bandPx)
  return {
    backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(sprocketTileSvg(bandPx))}")`,
    backgroundSize: `${r1(g.pitch)}px ${bandPx}px`,
  }
}

/** How the chip's height splits: the band, then the pictures. A row too short
 *  for both keeps the band and as much picture as fits. */
export function filmStripRows(chipH: number): { bandPx: number; pictureH: number } {
  const h = Math.max(0, Math.round(chipH))
  const bandPx = Math.min(FILM_SPROCKET_BAND_PX, h)
  return { bandPx, pictureH: Math.max(0, h - bandPx) }
}

/** A tile's width for a picture this tall, keeping board 56's 58 × 36 shape. */
export function filmTileWidthPx(pictureH: number): number {
  if (!(pictureH > 0)) return BOARD_TILE_W
  return Math.max(MIN_TILE_W, Math.round((pictureH * BOARD_TILE_W) / BOARD_PICTURE_H))
}

/**
 * The grid a tile's moment is snapped to. A tile shows the frame at its own
 * middle, and that moment moves with every zoom; snapping it to a grid a
 * little finer than the tile means zooming in or out lands on moments already
 * fetched, so the cache keeps paying. The grid steps are "nice" seconds.
 */
const FRAME_GRID_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300] as const

export function filmFrameGridSec(tileSec: number): number {
  const want = tileSec / 2
  for (const step of FRAME_GRID_STEPS) if (step >= want) return step
  return FRAME_GRID_STEPS[FRAME_GRID_STEPS.length - 1]
}

/** Stay this far inside the film's end: a seek into its last moments can land
 *  past the final keyframe and never produce a picture. */
const FILM_END_MARGIN_SEC = 0.1

export interface FilmTile {
  /** Its place along the strip, from the film's start. */
  index: number
  leftPx: number
  widthPx: number
  /** The moment of the film it shows, on the snapping grid. */
  sec: number
}

/**
 * The tiles that touch the visible window, and only those — an hour of film
 * at full zoom is thousands of tiles, and the frames behind them cost a fetch
 * each. The last tile is cut short at the film's end.
 */
export function visibleFilmTiles(args: {
  filmSec: number
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  tilePx: number
}): FilmTile[] {
  const { filmSec, pxPerSec, viewStartSec, viewEndSec, tilePx } = args
  if (!(filmSec > 0) || !(pxPerSec > 0) || !(tilePx > 0)) return []
  const stripPx = filmSec * pxPerSec
  const first = Math.max(0, Math.floor((Math.max(0, viewStartSec) * pxPerSec) / tilePx))
  const lastPx = Math.min(stripPx, Math.max(0, viewEndSec) * pxPerSec)
  if (lastPx <= first * tilePx) return []
  const last = Math.ceil(lastPx / tilePx) - 1
  const grid = filmFrameGridSec(tilePx / pxPerSec)
  const latest = Math.max(0, filmSec - FILM_END_MARGIN_SEC)
  const out: FilmTile[] = []
  for (let i = first; i <= last; i++) {
    const leftPx = i * tilePx
    const widthPx = Math.min(tilePx, stripPx - leftPx)
    if (widthPx <= 0) break
    const mid = (leftPx + widthPx / 2) / pxPerSec
    const snapped = Math.round(mid / grid) * grid
    out.push({ index: i, leftPx, widthPx, sec: Math.min(latest, Math.max(0, Math.round(snapped * 100) / 100)) })
  }
  return out
}
