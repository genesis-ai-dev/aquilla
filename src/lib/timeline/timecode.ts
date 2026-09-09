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

/** The one thing a typed span cannot be. */
export type SpanProblem = "inverted"

/**
 * Is this a span at all?
 *
 * OVERLAP IS ALLOWED, deliberately (Sam, 2026-09-09). Typing exact times is
 * precisely when a person wants two lines to sound together — two speakers
 * talking over each other is a real thing a subtitle has to say, and the
 * formats express it happily. An earlier cut of this clamped a typed span
 * inside its neighbours on the grounds that the text table orders rows by the
 * anchor chain while the media lens sorts by the clock. That reasoning was too
 * broad: the lens sorts on START time (`sortByLens`), so a line that merely
 * overlaps its neighbour still sorts after it and the two orders agree. Only
 * moving a start BEFORE the previous line's start would part them, which is a
 * different act from overlapping.
 *
 * What is left is the one span that cannot mean anything: an end at or before
 * its start. That is refused rather than repaired — the caller says so and
 * keeps what was typed, because silently swapping two fields is a worse
 * surprise than being told.
 *
 * The timeline's DRAG still bounds itself by the neighbouring chips. The two
 * entry points differ on purpose: a drag is a gesture at a position, where
 * sliding under the next cue is almost always a slip, and typing is a
 * statement of intent.
 */
export function spanProblem(startSec: number, endSec: number): SpanProblem | null {
  // Whole milliseconds, because that is what the write stores — two values a
  // microsecond apart are the same instant once saved, and calling that a
  // valid span would store a cue of no length.
  const ms = (sec: number) => Math.round(sec * 1000)
  return ms(endSec) <= ms(startSec) ? "inverted" : null
}
