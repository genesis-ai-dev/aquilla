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

import type { MouseEvent as ReactMouseEvent } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { TL_CHIP_BOX_CLASS, TL_ROW_H_CLASS } from "@/lib/timeline/row-metrics"
import { filmTrackHueVars } from "@/lib/timeline/track-colors"
import {
  FILM_STRIP_COLOR,
  FILM_STRIP_RADIUS_PX,
  filmStripRows,
  filmTileWidthPx,
  sprocketBackground,
  visibleFilmTiles,
} from "@/lib/timeline/film-strip"
import { useRowMetrics } from "./useRowMetrics"

export interface FilmTrackLaneProps {
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
  /** The picture for a tile's moment, or null while there is none. */
  frameFor?(sec: number): string | null
}

/** The strip's 1 px dark edge (board 56). */
const STRIP_EDGE = "0 0 0 1px rgba(17,18,20,0.55)"

export function FilmTrackLane({
  filmSec,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  name,
  onSeekSec,
  frameFor,
}: FilmTrackLaneProps) {
  const t = useT()
  const { chipH } = useRowMetrics()
  const { bandPx, pictureH } = filmStripRows(chipH)
  const tilePx = filmTileWidthPx(pictureH)
  const stripPx = filmSec && filmSec > 0 ? filmSec * pxPerSec : 0
  const tiles =
    stripPx > 0 && pictureH > 0
      ? visibleFilmTiles({ filmSec: filmSec!, pxPerSec, viewStartSec, viewEndSec, tilePx })
      : []

  const seekFromClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onSeekSec || !(pxPerSec > 0)) return
    const box = e.currentTarget.getBoundingClientRect()
    const sec = (e.clientX - box.left) / pxPerSec
    if (Number.isFinite(sec)) onSeekSec(Math.max(0, Math.min(filmSec ?? 0, sec)))
  }

  return (
    <div
      data-testid="tl-film-lane"
      className={`relative ${TL_ROW_H_CLASS} border-b border-border`}
      style={filmTrackHueVars()}
    >
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
          {bandPx > 0 && (
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
          )}
          {pictureH > 0 && (
            <div className="relative shrink-0 overflow-hidden" style={{ height: `${pictureH}px` }} aria-hidden>
              {tiles.map((tile) => {
                const url = frameFor?.(tile.sec) ?? null
                return url ? (
                  <img
                    key={tile.index}
                    data-testid="tl-film-frame"
                    data-frame-sec={tile.sec}
                    alt=""
                    src={url}
                    draggable={false}
                    className="absolute top-0 block h-full object-cover"
                    style={{ left: `${tile.leftPx}px`, width: `${tile.widthPx}px` }}
                  />
                ) : (
                  <span
                    key={tile.index}
                    data-testid="tl-film-frame-empty"
                    data-frame-sec={tile.sec}
                    className="absolute top-0 block h-full"
                    style={{ left: `${tile.leftPx}px`, width: `${tile.widthPx}px`, background: FILM_STRIP_COLOR }}
                  />
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
