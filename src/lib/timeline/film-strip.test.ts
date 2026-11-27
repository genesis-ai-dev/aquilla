import { describe, expect, it } from "vitest"
import {
  FILM_SPROCKET_BAND_PX,
  filmFrameGridSec,
  filmStripRows,
  filmTileWidthPx,
  sprocketGeometry,
  visibleFilmTiles,
} from "./film-strip"

// AQU-2253: board 56's film strip, number for number (film_track.py).
describe("the film strip's geometry (board 56)", () => {
  it("the sprocket band is 10 px, along the top only", () => {
    expect(FILM_SPROCKET_BAND_PX).toBe(10)
    // A 46 px chip: the band, then 36 px of pictures.
    expect(filmStripRows(46)).toEqual({ bandPx: 10, pictureH: 36 })
  })

  it("the holes scale with the band, as sprockets() draws them", () => {
    const g = sprocketGeometry(10)
    expect(g.pitch).toBeCloseTo(12.9)
    expect(g.holeW).toBeCloseTo(5.7)
    expect(g.holeH).toBeCloseTo(4.3)
    expect(g.radius).toBeCloseTo(1.29)
    expect(g.holeX).toBeCloseTo((12.9 - 5.7) / 2)
    expect(g.holeY).toBeCloseTo((10 - 4.3) / 2)
    // A smaller band keeps the board's floors.
    expect(sprocketGeometry(5)).toMatchObject({ pitch: 8, holeW: 3, holeH: 2.15 })
  })

  it("a tile is 58 px over a 36 px picture, and keeps that shape", () => {
    expect(filmTileWidthPx(36)).toBe(58)
    expect(filmTileWidthPx(72)).toBe(116)
    expect(filmTileWidthPx(4)).toBe(16)
  })

  it("a short row keeps the band and as much picture as fits", () => {
    expect(filmStripRows(18)).toEqual({ bandPx: 10, pictureH: 8 })
    expect(filmStripRows(6)).toEqual({ bandPx: 6, pictureH: 0 })
  })
})

describe("visibleFilmTiles", () => {
  // The demo's film: 27.08 s, at the timeline's default zoom.
  const base = { filmSec: 27.08, pxPerSec: 38, tilePx: 58 }

  it("tiles from 0:00, one picture per 58 px, each the moment at its middle", () => {
    const tiles = visibleFilmTiles({ ...base, viewStartSec: 0, viewEndSec: 5 })
    expect(tiles.map((t) => t.leftPx)).toEqual([0, 58, 116, 174])
    // 58 px at 38 px/s is 1.53 s a tile; its middle is snapped to a 1 s grid.
    expect(tiles.map((t) => t.sec)).toEqual([1, 2, 4, 5])
  })

  it("draws only what is in view", () => {
    const tiles = visibleFilmTiles({ ...base, viewStartSec: 10, viewEndSec: 12 })
    expect(tiles[0].index).toBe(Math.floor((10 * 38) / 58))
    expect(tiles.at(-1)!.leftPx).toBeLessThan(12 * 38)
  })

  it("ends where the film ends — the last tile is cut short, and nothing past it", () => {
    const tiles = visibleFilmTiles({ ...base, viewStartSec: 20, viewEndSec: 60 })
    const last = tiles.at(-1)!
    expect(last.leftPx + last.widthPx).toBeCloseTo(27.08 * 38)
    expect(last.widthPx).toBeLessThan(58)
    expect(last.sec).toBeLessThanOrEqual(27.08)
    expect(visibleFilmTiles({ ...base, viewStartSec: 30, viewEndSec: 60 })).toEqual([])
  })

  it("no film length, no tiles", () => {
    expect(visibleFilmTiles({ ...base, filmSec: 0, viewStartSec: 0, viewEndSec: 5 })).toEqual([])
  })

  it("snaps to a grid finer than a tile, so zooming lands on moments already fetched", () => {
    expect(filmFrameGridSec(1.53)).toBe(1)
    expect(filmFrameGridSec(0.24)).toBe(0.2)
    expect(filmFrameGridSec(7)).toBe(5)
    const near = visibleFilmTiles({ ...base, pxPerSec: 40, viewStartSec: 0, viewEndSec: 27 }).map((t) => t.sec)
    const far = visibleFilmTiles({ ...base, pxPerSec: 20, viewStartSec: 0, viewEndSec: 27 }).map((t) => t.sec)
    expect(far.every((sec) => near.includes(sec) || Number.isInteger(sec))).toBe(true)
  })
})
