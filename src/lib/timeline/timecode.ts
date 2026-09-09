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

/** Why a typed span cannot be saved. */
export type SpanProblem =
  /** The end is at or before the start — a cue of no length says nothing. */
  | "inverted"
  /** Its start would move above the line before it, changing the file's order. */
  | "startsBeforePrevious"
  /** Its start would move below the line after it, likewise. */
  | "startsAfterNext"

/** The starts of the lines either side of this one, in CLOCK order. Null at
 *  either end of the file, and for a neighbour that carries no timing of its
 *  own — an untimed row bounds nothing. */
export interface StartBounds {
  prevStartSec: number | null
  nextStartSec: number | null
}

/**
 * Can this span be saved?
 *
 * OVERLAP IS ALLOWED IN FULL (Sam, 2026-09-09). A line may run into the one
 * after it, or start under the tail of the one before, for as long as it likes
 * — two speakers talking over each other is a real thing a subtitle says, both
 * VTT and SRT express it, and the exporters already sort cues by start time
 * (`sortedByTime`) precisely because the clock is the authority for a timed
 * file. Typing exact times is when somebody means it.
 *
 * ONE LIMIT SURVIVES, and it is the narrowest one that keeps the file coherent:
 * a line's START may not pass either neighbour's START. Order in the media lens
 * and in every timed export is by start time and nothing else (`sortByLens`),
 * while the text table reads the anchor chain — so as long as consecutive
 * starts stay in sequence the two orders agree, and the moment one crosses they
 * do not. The END is unbounded because the end never decides order.
 *
 * Both directions, deliberately: a start dragged back above the PREVIOUS line's
 * start breaks the order exactly as one pushed past the next line's does, and a
 * rule that named only the following line would miss half of it.
 */
export function spanProblem(
  startSec: number,
  endSec: number,
  bounds?: StartBounds,
): SpanProblem | null {
  // Whole milliseconds, because that is what the write stores — two values a
  // microsecond apart are the same instant once saved, so a span between them
  // would be a cue of no length, and a start "before" a neighbour by less than
  // a millisecond is the same start.
  const ms = (sec: number) => Math.round(sec * 1000)
  // The span's own coherence first: it is the more actionable answer when a
  // value is both inverted and out of order.
  if (ms(endSec) <= ms(startSec)) return "inverted"
  if (bounds?.prevStartSec != null && ms(startSec) < ms(bounds.prevStartSec)) return "startsBeforePrevious"
  if (bounds?.nextStartSec != null && ms(startSec) > ms(bounds.nextStartSec)) return "startsAfterNext"
  return null
}
