// AQU-1068 item 5: reading a timecode a person TYPED, and keeping the span
// they typed inside its neighbours.
//
// Everything that parses a timecode in this codebase today reads a machine's
// output — `parseTimestampRange` (lib/video/vtt-generator.ts) and the subtitle
// parsers all match a whole `HH:MM:SS.mmm --> HH:MM:SS.mmm` line with every
// field at its full width, because that is what a VTT file contains. None of
// them will read `1:02.5`, which is what somebody types when the chip they are
// looking at says `1:02.5`.
//
// So this module is deliberately lenient on the way IN and exact on the way
// OUT: `fmtDragTime` renders the value back in the timeline's own millisecond
// format, and the popover writes that back into the field, so a person can
// always see precisely what they committed.

import { MIN_ADDABLE_SPAN_SEC } from "./lane-timing"

/**
 * Seconds from a typed timecode, or null when it is not one.
 *
 * Accepts, in the shapes people actually type:
 *   - `62`, `62.5`      — bare seconds, the fastest thing to type
 *   - `1:02`, `1:02.5`  — what the timeline's idle chip shows
 *   - `01:02.500`       — what its drag readout shows
 *   - `00:01:02,500`    — what a VTT/SRT file contains, comma or dot
 *
 * Minutes and seconds may be one or two digits; hours are optional and
 * unbounded (a long film runs past 99 minutes). Milliseconds are one to three
 * digits and read positionally, so `.5` is half a second, not five thousandths
 * — the trap that makes a naive `parseInt` turn a tenth into a millisecond.
 *
 * Returns null rather than 0 for anything unreadable: the caller has to tell
 * "they meant the start of the file" from "this is not a time", and silently
 * committing 0 would move a cue to the top of the film.
 */
export function parseTimecode(input: string): number | null {
  const raw = input.trim()
  if (raw === "") return null
  // No sign: a negative time is not a position in a file, and allowing "-" to
  // parse would let a clamp quietly turn it into 0 instead of reporting it.
  const match = /^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw)
  if (!match) return null
  const [, a, b, secText, fracText] = match

  // One colon means MM:SS, two mean HH:MM:SS. With one, the regex fills the
  // FIRST group, so the lone value is the minutes.
  const hours = b === undefined ? 0 : Number(a ?? 0)
  const minutes = b === undefined ? Number(a ?? 0) : Number(b)
  const seconds = Number(secText)

  // Only the leading field may exceed its usual range: `90:00` is a legitimate
  // way to type ninety minutes, while `1:90:00` is a typo for `2:30:00` and
  // reading it as ninety minutes-past-the-hour would be a guess.
  if (b !== undefined && minutes > 59) return null
  if ((a !== undefined || b !== undefined) && seconds > 59) return null

  // Positional: ".5" is 500ms, ".05" is 50ms, ".005" is 5ms.
  const ms = fracText === undefined ? 0 : Number(fracText.padEnd(3, "0"))
  return hours * 3600 + minutes * 60 + seconds + ms / 1000
}

export interface SpanBounds {
  startSec: number
  endSec: number
  /** End of the line before this one, or null when it is the first. */
  prevEndSec: number | null
  /** Start of the line after this one, or null when it is the last. */
  nextStartSec: number | null
}

export interface ClampedSpan {
  startSec: number
  endSec: number
  /** True when the bounds moved either edge away from what was asked for. */
  clamped: boolean
}

/**
 * Hold a typed span inside its neighbours.
 *
 * THIS IS NOT POLITENESS. The text table orders rows by the anchor chain while
 * the media lens sorts them by the clock, and those two orders agreeing is an
 * invariant several rounds of this PR went into restoring. A span dragged past
 * its neighbour is refused by the timeline for the same reason; typing one has
 * to be refused the same way or the two entry points disagree about what the
 * file may look like.
 *
 * The caller is told when the bounds bit (`clamped`), so the popover can write
 * the corrected value back into the field rather than silently saving
 * something other than what was typed.
 */
export function clampSpan({ startSec, endSec, prevEndSec, nextStartSec }: SpanBounds): ClampedSpan {
  const floor = Math.max(0, prevEndSec ?? 0)
  // A missing neighbour is open-ended in that direction — the last line of a
  // file with no known duration may run as long as it likes.
  const ceiling = nextStartSec ?? Number.POSITIVE_INFINITY

  let start = Math.min(Math.max(startSec, floor), ceiling)
  let end = Math.min(Math.max(endSec, floor), ceiling)

  // Inverted or too short. Grow the END first, because the start is the edge
  // the person was more likely aiming at; only push the start back when there
  // is no room after it, which happens in a silence barely wider than the
  // floor.
  if (end - start < MIN_ADDABLE_SPAN_SEC) {
    end = start + MIN_ADDABLE_SPAN_SEC
    if (end > ceiling) {
      end = ceiling
      start = Math.max(floor, end - MIN_ADDABLE_SPAN_SEC)
    }
  }

  // Compare in whole milliseconds: the write rounds to ms, so a difference
  // below that is not a change anyone can observe and must not be reported as
  // one.
  const movedMs = (a: number, b: number) => Math.round(a * 1000) !== Math.round(b * 1000)
  return { startSec: start, endSec: end, clamped: movedMs(start, startSec) || movedMs(end, endSec) }
}
