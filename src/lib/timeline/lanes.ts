// Timeline editor v1 — derive lanes from single-source cells (no schema change).
// Dialogue lane = timed media cells; Subtitle lane = timed non-media cells;
// Untimed = anything without usable timing. Pure; never mutates input.
//
// AQU-646: for a pure-audio file (no real subtitle cells) the Subtitle lane
// MIRRORS the media cells that carry text — same objects, appearing in both
// lanes — so the transcript/translation reads as a text track above the audio
// blocks. Mixed files (real subtitle cells present) never mirror.
import { hasTiming, sortByLens, type TimelineSegment } from "./derive"

export interface Lanes<T extends TimelineSegment> {
  dialogue: T[]
  subtitle: T[]
  untimed: T[]
}

const isMedia = (s: TimelineSegment) => (s.medium ?? "text") === "media"

/** The text a subtitle-lane mirror card shows for a media cell: the
 *  translation once translated, the transcript before that (Sam's pick). */
export function subtitleMirrorText(s: TimelineSegment): string {
  return (s.translated?.trim() || s.transcription?.trim()) ?? ""
}

export function deriveLanes<T extends TimelineSegment>(segments: readonly T[]): Lanes<T> {
  const dialogue: T[] = []
  const subtitle: T[] = []
  const untimed: T[] = []
  for (const s of segments) {
    if (!hasTiming(s)) untimed.push(s)
    else if (isMedia(s)) dialogue.push(s)
    else subtitle.push(s)
  }
  if (subtitle.length === 0) {
    for (const s of dialogue) {
      if (subtitleMirrorText(s) !== "") subtitle.push(s)
    }
  }
  return {
    dialogue: sortByLens(dialogue, "time"),
    subtitle: sortByLens(subtitle, "time"),
    untimed: sortByLens(untimed, "sequence"),
  }
}
