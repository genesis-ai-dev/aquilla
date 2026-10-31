// The film track's lane (AQU-2253, canvas board 56): the linked film as one
// strip pinned at the very top of the timeline, in both timings.
//
// It runs on the film's own clock. The strip starts at 0:00 and ends where
// the film ends, at the timeline's zoom; following the recordings the lines
// re-flow and the film does not, so the two simply start together. Past the
// film's end there is no strip (a book longer than its film), and the Film
// panel holds the last frame.
//
// Across its top runs a 10 px perforated border (Sam, Oct 29: "only a top film
// track border"), and the film's frames tile along it at the current zoom,
// each showing the moment at its middle. Where frames cannot be had (a YouTube
// film, a server that refuses them, before they arrive) the tile is the
// strip's own black under the same border: still plainly the film.
//
// AQU-2253 (Sam, Oct 30): an IMPORTED film (a video uploaded through the
// importer) is cut along its source cues instead (lib/timeline/film-pieces).
// Following the recordings each line's piece sits in that line's slot, with
// its frames from its own stretch of the film, and where the line's recording
// runs longer than its original the piece holds its last frame (drawn faded
// and hatched, as board 56's chopped version drew a hold). Following the
// source its pieces sit end to end, which is exactly the one strip above.

import { useEffect, type MouseEvent as ReactMouseEvent } from "react"
import type { FrontierSession } from "@/lib/frontier/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { TL_CHIP_BOX_CLASS, TL_ROW_H_CLASS } from "@/lib/timeline/row-metrics"
import { filmTrackHueVars } from "@/lib/timeline/track-colors"
import {
  FILM_STRIP_COLOR,
  FILM_STRIP_RADIUS_PX,
  filmFrameGridSec,
  filmStripRows,
  filmTileWidthPx,
  sprocketBackground,
  visibleFilmTiles,
} from "@/lib/timeline/film-strip"
import { visibleFilmPieceStrips, type FilmPiece } from "@/lib/timeline/film-pieces"
import { useRowMetrics } from "./useRowMetrics"
import { useFilmFrames } from "./useFilmFrames"

export interface FilmTrackLaneProps {
  /** The film as linked (`coreMediaUrl`), and what resolving an uploaded one
   *  needs. The frames come from it (see useFilmFrames). */
  src: string
  fileId: string
  projectId?: string
  session?: FrontierSession | null
  /** How long the film is. Null until the film reports it: the row is there,
   *  the strip is not yet. */
  filmSec: number | null
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  /** The film's name, for the strip's accessible name. */
  name: string
  /** A click on the strip moves the playhead (and so the film) there. */
  onSeekSec?(sec: number): void
  /** Test seam: the picture for a tile's moment. Given, the film itself is
   *  never read. */
  frameFor?(sec: number): string | null
  /**
   * AQU-2253 (Sam, Oct 30): an imported film following the recordings, cut
   * into its lines' pieces (`filmPiecesFor`). Given, the lane draws one chip
   * per piece at its line's slot instead of the one strip on the film's clock.
   * Null or absent: the one strip.
   */
  pieces?: readonly FilmPiece[] | null
}

/** The strip's 1 px dark edge (board 56). */
const STRIP_EDGE = "0 0 0 1px rgba(17,18,20,0.55)"
/** A held stretch, as board 56's chopped version drew it: the last frame
 *  faded, under a light diagonal hatch, after a white line where it stops. */
const HELD_HATCH = "repeating-linear-gradient(135deg, rgba(255,255,255,0) 0 6px, rgba(255,255,255,0.28) 6px 8px)"
const HELD_FRAME_OPACITY = 0.45

export function FilmTrackLane({
  src,
  fileId,
  projectId,
  session,
  filmSec,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  name,
  onSeekSec,
  frameFor,
  pieces,
}: FilmTrackLaneProps) {
  const t = useT()
  const { chipH } = useRowMetrics()
  const { bandPx, pictureH } = filmStripRows(chipH)
  const tilePx = filmTileWidthPx(pictureH)
  const cut = pieces != null
  const stripPx = !cut && filmSec && filmSec > 0 ? filmSec * pxPerSec : 0
  const tiles =
    stripPx > 0 && pictureH > 0
      ? visibleFilmTiles({ filmSec: filmSec!, pxPerSec, viewStartSec, viewEndSec, tilePx })
      : []
  const pieceStrips =
    cut && pxPerSec > 0
      ? visibleFilmPieceStrips({
          pieces: pieces!,
          pxPerSec,
          viewStartSec,
          viewEndSec,
          tilePx,
          gridSec: filmFrameGridSec(tilePx / pxPerSec),
        })
      : []
  const piecesEndPx = cut && pieces!.length > 0 ? (pieces![pieces!.length - 1].atSec + pieces![pieces!.length - 1].lenSec) * pxPerSec : 0

  const frames = useFilmFrames({ src, fileId, projectId, session, enabled: !frameFor })
  const pictureFor = frameFor ?? frames.frameFor
  // Ask for the tiles in view, and only those. Keyed on their moments, so a
  // render that changes nothing about them asks for nothing new. A held
  // piece's tiles share its last frame, so it costs one.
  const tileSecs = (cut
    ? [...new Set(pieceStrips.flatMap((strip) => (pictureH > 0 ? strip.tiles.map((tile) => tile.sec) : [])))]
    : tiles.map((tile) => tile.sec)
  ).join(",")
  const want = frames.want
  useEffect(() => {
    want(tileSecs ? tileSecs.split(",").map(Number) : [])
  }, [want, tileSecs])

  const seekFromClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onSeekSec || !(pxPerSec > 0)) return
    const box = e.currentTarget.getBoundingClientRect()
    const sec = (e.clientX - box.left) / pxPerSec
    const endSec = cut ? piecesEndPx / pxPerSec : (filmSec ?? 0)
    if (Number.isFinite(sec)) onSeekSec(Math.max(0, Math.min(endSec, sec)))
  }

  const sprockets = bandPx > 0 && (
    <div
      data-testid="tl-film-sprockets"
      aria-hidden
      className="shrink-0"
      style={{
        height: `${bandPx}px`,
        backgroundColor: FILM_STRIP_COLOR,
        backgroundRepeat: "repeat-x",
        ...sprocketBackground(bandPx),
      }}
    />
  )
  const tileImage = (key: number, sec: number, leftPx: number, widthPx: number, held = false) => {
    const url = pictureFor(sec)
    const style = { left: `${leftPx}px`, width: `${widthPx}px`, ...(held ? { opacity: HELD_FRAME_OPACITY } : {}) }
    return url ? (
      <img
        key={key}
        data-testid="tl-film-frame"
        data-frame-sec={sec}
        {...(held ? { "data-held": "" } : {})}
        alt=""
        src={url}
        draggable={false}
        className="absolute top-0 block h-full object-cover"
        style={style}
      />
    ) : (
      <span
        key={key}
        data-testid="tl-film-frame-empty"
        data-frame-sec={sec}
        {...(held ? { "data-held": "" } : {})}
        className="absolute top-0 block h-full"
        style={{ ...style, background: FILM_STRIP_COLOR }}
      />
    )
  }

  return (
    <div
      data-testid="tl-film-lane"
      data-film-kind={cut ? "imported-pieces" : "one-strip"}
      className={`relative ${TL_ROW_H_CLASS} border-b border-border`}
      style={filmTrackHueVars()}
    >
      {frames.grabber}
      {stripPx > 0 && (
        <div
          data-testid="tl-film-strip"
          data-film-sec={filmSec}
          role="img"
          aria-label={t("editor.timeline.filmStripAria", { name })}
          onClick={seekFromClick}
          className={`absolute ${TL_CHIP_BOX_CLASS} flex cursor-pointer flex-col overflow-hidden`}
          style={{
            left: 0,
            // Board 56: like every chip, 2 px short of its end.
            width: `${Math.max(4, stripPx - 2)}px`,
            borderRadius: `${FILM_STRIP_RADIUS_PX}px`,
            background: FILM_STRIP_COLOR,
            boxShadow: STRIP_EDGE,
          }}
        >
          {sprockets}
          {pictureH > 0 && (
            <div className="relative shrink-0 overflow-hidden" style={{ height: `${pictureH}px` }} aria-hidden>
              {tiles.map((tile) => tileImage(tile.index, tile.sec, tile.leftPx, tile.widthPx))}
            </div>
          )}
        </div>
      )}
      {cut && piecesEndPx > 0 && (
        // The pieces, each its own chip at its line's slot. One click target
        // and one accessible picture over all of them, as the one strip is.
        <div
          data-testid="tl-film-strip"
          data-film-sec={filmSec ?? undefined}
          data-film-pieces={pieces!.length}
          role="img"
          aria-label={t("editor.timeline.filmStripAria", { name })}
          onClick={seekFromClick}
          className="absolute inset-y-0 left-0 cursor-pointer"
          style={{ width: `${piecesEndPx}px` }}
        >
          {pieceStrips.map(({ piece, leftPx, widthPx, heldFromPx, tiles: pieceTiles }) => (
            <div
              key={piece.cellId}
              data-testid="tl-film-piece"
              data-cell-id={piece.cellId}
              data-film-start={piece.filmStartSec}
              data-film-end={piece.filmEndSec}
              {...(heldFromPx != null ? { "data-held-from-px": heldFromPx.toFixed(1) } : {})}
              className={`absolute ${TL_CHIP_BOX_CLASS} flex flex-col overflow-hidden`}
              style={{
                left: `${leftPx}px`,
                width: `${widthPx}px`,
                borderRadius: `${FILM_STRIP_RADIUS_PX}px`,
                background: FILM_STRIP_COLOR,
                boxShadow: STRIP_EDGE,
              }}
            >
              {sprockets}
              {pictureH > 0 && (
                <div className="relative shrink-0 overflow-hidden" style={{ height: `${pictureH}px` }} aria-hidden>
                  {pieceTiles.map((tile) => tileImage(tile.index, tile.sec, tile.leftPx, tile.widthPx, tile.held))}
                </div>
              )}
              {heldFromPx != null && (
                <span
                  data-testid="tl-film-held"
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 right-0"
                  style={{ top: `${bandPx}px`, left: `${heldFromPx}px`, background: HELD_HATCH, borderLeft: "2px solid rgba(255,255,255,0.9)" }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
