// Which arrangement a file STARTS from, by what kind of file it is.
// (Media redesign, layout — Sam, Oct 23/24: "each file starts from a layout
// suited to its kind".)
//
// A starting layout is only ever a fallback: the moment someone drags a
// divider, folds a panel or presses full screen on a file, that file keeps
// their arrangement (per person, per file, in this browser), and "Reset
// layout" returns it here. Pure, so the picks are testable without the
// workspace.

import { TIMELINE_PANE_DEFAULT_HEIGHT } from "./timeline-pane-layout"
import { VIDEO_PANE_DEFAULT_WIDTH } from "./video-pane-layout"

export type MediaFileKind = "dub" | "subtitles" | "scripture" | "plain"

export interface MediaFileKindInput {
  /** A film is linked and shown beside the text. */
  hasVideo: boolean
  /** The file was imported from subtitles (a VTT/SRT). */
  isSubtitleFile: boolean
  /** The file is dubbed against an audio cue track (heard lines). */
  hasAudioCues: boolean
  /** A scripture book (USFM / eBible / helloao, or a corpus marker). */
  isScripture: boolean
}

export function mediaFileKind(input: MediaFileKindInput): MediaFileKind {
  if (input.hasVideo && input.hasAudioCues) return "dub"
  if (input.hasVideo && input.isSubtitleFile) return "subtitles"
  if (input.isScripture && !input.hasVideo) return "scripture"
  return "plain"
}

/** A panel's size: pixels, or a share of the space its group has. */
export type PanelSize = number | `${number}%`

/**
 * AQU-2343 (Sam, Nov 2, from a screenshot of the arrangement he wanted): a
 * file whose film shows starts with the timeline a little under half the
 * media view's height and the film about a third of the row below it, the
 * text taking the rest. Shares, not pixels, so it looks the same on any
 * window.
 */
export const FILM_TIMELINE_SHARE = "45%"
export const FILM_WIDTH_SHARE = "38%"

export interface StartingLayout {
  /** The timeline panel's height: pixels, or a share of the media view. */
  timelineHeight: PanelSize
  /** The film's width: pixels, or a share of the row below the timeline —
   *  only used when a film is shown. */
  videoWidth: PanelSize
}

/**
 * - A file whose film shows (a dubbing episode, a subtitles file, or any
 *   other file with a film linked): the shares above (AQU-2343).
 * - scripture: no film, so the timeline gets the room (460 px).
 * - plain: the timeline at its usual height.
 *
 * The pixel numbers are the docking mock-up's (Media Redesign canvas,
 * board 18). `filmShown` is whether the film panel shows; a dubbing or
 * subtitles file has a film by definition.
 */
export function startingLayout(kind: MediaFileKind, filmShown = kind === "dub" || kind === "subtitles"): StartingLayout {
  if (filmShown) return { timelineHeight: FILM_TIMELINE_SHARE, videoWidth: FILM_WIDTH_SHARE }
  switch (kind) {
    case "scripture":
      return { timelineHeight: 460, videoWidth: VIDEO_PANE_DEFAULT_WIDTH }
    case "dub":
    case "subtitles":
    case "plain":
      return { timelineHeight: TIMELINE_PANE_DEFAULT_HEIGHT, videoWidth: VIDEO_PANE_DEFAULT_WIDTH }
  }
}
