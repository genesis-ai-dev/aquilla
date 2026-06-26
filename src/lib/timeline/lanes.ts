// Timeline editor v1 — derive lanes from single-source cells (no schema change).
// Dialogue lane = timed media cells; Subtitle lane = timed non-media cells;
// Untimed = anything without usable timing. Pure; never mutates input.
import { hasTiming, sortByLens, type TimelineSegment } from "./derive"

export interface Lanes<T extends TimelineSegment> {
  dialogue: T[]
  subtitle: T[]
  untimed: T[]
}

const isMedia = (s: TimelineSegment) => (s.medium ?? "text") === "media"

export function deriveLanes<T extends TimelineSegment>(segments: readonly T[]): Lanes<T> {
  const dialogue: T[] = []
  const subtitle: T[] = []
  const untimed: T[] = []
  for (const s of segments) {
    if (!hasTiming(s)) untimed.push(s)
    else if (isMedia(s)) dialogue.push(s)
    else subtitle.push(s)
  }
  return {
    dialogue: sortByLens(dialogue, "time"),
    subtitle: sortByLens(subtitle, "time"),
    untimed: sortByLens(untimed, "sequence"),
  }
}
