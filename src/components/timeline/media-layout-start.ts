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

export interface StartingLayout {
  /** The timeline panel's height, px. */
  timelineHeight: number
  /** The film's width, px — only used when a film is shown. */
  videoWidth: number
}

/**
 * - dub: the film large, beside the lines it is dubbed against (480 px), with
 *   the timeline at its usual height.
 * - subtitles: the text large — the film at today's 288 px, the timeline
 *   shorter (220 px), since subtitles are worked line by line in the table.
 * - scripture: no film, so the timeline gets the room (460 px).
 * - plain: today's defaults.
 *
 * The numbers are the docking mock-up's (Media Redesign canvas, board 18).
 */
export function startingLayout(kind: MediaFileKind): StartingLayout {
  switch (kind) {
    case "dub":
      return { timelineHeight: TIMELINE_PANE_DEFAULT_HEIGHT, videoWidth: 480 }
    case "subtitles":
      return { timelineHeight: 220, videoWidth: VIDEO_PANE_DEFAULT_WIDTH }
    case "scripture":
      return { timelineHeight: 460, videoWidth: VIDEO_PANE_DEFAULT_WIDTH }
    case "plain":
      return { timelineHeight: TIMELINE_PANE_DEFAULT_HEIGHT, videoWidth: VIDEO_PANE_DEFAULT_WIDTH }
  }
}
