// Video timecode, and the one way a subtitle file's times go wrong with it.
// (AQU-2197, 2026-10-26, from Come and See's re-delivered episode 101.)
//
// Film people write times as TIMECODE: `00:01:06:15` is one hour-minute-second
// label and then a FRAME number, 15 of the 24 frames in that second at 24 fps.
// Subtitle files write `00:01:06.625`: milliseconds. Converting one to the
// other needs the frame rate, and a converter that forgets it writes the frame
// number into the hundredths: `00:01:06:15` became `00:01:06.150` in their VTT,
// so that line starts 0.475 s early, and every line is early by up to 0.7 s.
//
// Two jobs live here, both pure and worker-safe (the sync-worker reuses the
// parse core, so no `@/` imports and nothing from the DOM):
//
//   - reading timecode at a given frame rate (a character sheet's times);
//   - noticing a subtitle file whose times are frames written as hundredths,
//     and converting it at a frame rate a person picks.

import type { TranslatableString } from "./core-types"

/** The frame rates film and video actually use. `nominal` is the frame count a
 *  timecode label counts to in one second (24 for 23.976 as well as 24). */
export interface FrameRate {
  label: "23.976" | "24" | "25" | "29.97" | "30"
  fps: number
  nominal: number
}

export const FRAME_RATES: readonly FrameRate[] = [
  { label: "23.976", fps: 24000 / 1001, nominal: 24 },
  { label: "24", fps: 24, nominal: 24 },
  { label: "25", fps: 25, nominal: 25 },
  { label: "29.97", fps: 30000 / 1001, nominal: 30 },
  { label: "30", fps: 30, nominal: 30 },
]

export type FrameRateLabel = FrameRate["label"]

export function frameRateFor(label: FrameRateLabel): FrameRate {
  return FRAME_RATES.find((r) => r.label === label)!
}

/** `HH:MM:SS:FF` (or `HH:MM:SS;FF`, drop-frame), already split. */
export interface Timecode {
  hours: number
  minutes: number
  seconds: number
  frames: number
  /** Written with `;` before the frames: 29.97 drop-frame timecode. */
  dropFrame: boolean
}

const TIMECODE = /^(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2})$/

/** Read `00:01:03:05` (or `00:01:03;05`). Undefined for anything else,
 *  including the ordinary `00:01:03.050`, which is not timecode. */
export function parseTimecode(raw: string): Timecode | undefined {
  const m = (raw ?? "").trim().match(TIMECODE)
  if (!m) return undefined
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  if (minutes > 59 || seconds > 59) return undefined
  return {
    hours: Number(m[1]),
    minutes,
    seconds,
    frames: Number(m[5]),
    dropFrame: m[4] === ";",
  }
}

/**
 * Seconds for a timecode at a frame rate, or undefined when the timecode
 * cannot be at that rate: a frame number the rate never reaches (frame 24 at
 * 24 fps), or drop-frame marking on anything but 29.97.
 *
 * 23.976 and 29.97 count their labels like 24 and 30 but run 0.1% slower, so
 * the frame count is divided by the real rate; drop-frame skips frames 0 and 1
 * at the start of every minute except each tenth, which keeps its labels on the
 * wall clock.
 */
export function timecodeToSeconds(tc: Timecode, rate: FrameRate): number | undefined {
  if (tc.frames >= rate.nominal) return undefined
  if (tc.dropFrame && rate.label !== "29.97") return undefined
  let frames = (tc.hours * 3600 + tc.minutes * 60 + tc.seconds) * rate.nominal + tc.frames
  if (tc.dropFrame) {
    const totalMinutes = tc.hours * 60 + tc.minutes
    frames -= 2 * (totalMinutes - Math.floor(totalMinutes / 10))
  }
  return frames / rate.fps
}

// ── Frames written as hundredths ─────────────────────────────────────────

/** Fewer cues than this and the pattern below could be chance. */
export const FRAMES_AS_HUNDREDTHS_MIN_CUES = 20

export interface FramesAsHundredths {
  /** Cue start and end times looked at. */
  times: number
  /** The highest "frame" seen: the largest hundredths value, so 23 for `.230`. */
  maxFrame: number
  /** The rate to offer first: the smallest whose frames reach `maxFrame`. */
  suggested: FrameRateLabel
  /** Rates a person may pick: those whose frame count is above `maxFrame`. */
  rates: FrameRateLabel[]
}

/** Milliseconds within the second, 0–999, rounded off float noise. */
function millisOf(t: number): number {
  const ms = Math.round((t - Math.floor(t)) * 1000)
  return ms >= 1000 ? 0 : ms
}

/**
 * Does this file's every cue time look like a frame number written as
 * hundredths of a second?
 *
 * The tell is unmistakable over a real file: every millisecond value is a
 * multiple of ten (`.150`, never `.153`), and none goes above `.290`, because
 * no frame rate reaches 30 frames. A file genuinely timed to the hundredth uses
 * the whole second, so across twenty cues and more it all but certainly shows
 * a `.4` or a `.8` somewhere. Whole seconds alone prove nothing, so enough
 * times must carry a fraction at all.
 */
export function detectFramesAsHundredths(
  strings: readonly Pick<TranslatableString, "start" | "end">[],
): FramesAsHundredths | null {
  const times: number[] = []
  let cues = 0
  for (const s of strings) {
    if (typeof s.start !== "number" || typeof s.end !== "number") continue
    cues++
    times.push(s.start, s.end)
  }
  if (cues < FRAMES_AS_HUNDREDTHS_MIN_CUES) return null
  let maxMs = 0
  let withFraction = 0
  for (const t of times) {
    const ms = millisOf(t)
    if (ms % 10 !== 0 || ms > 290) return null
    if (ms > 0) withFraction++
    if (ms > maxMs) maxMs = ms
  }
  if (withFraction < Math.max(5, Math.ceil(times.length * 0.1))) return null
  const maxFrame = maxMs / 10
  const rates = FRAME_RATES.filter((r) => r.nominal > maxFrame).map((r) => r.label)
  const suggested: FrameRateLabel = maxFrame <= 23 ? "24" : maxFrame <= 24 ? "25" : "30"
  return { times: times.length, maxFrame, suggested, rates }
}

/** One of those times, read back as the timecode it came from, at `rate`. */
function framesAsHundredthsToSeconds(t: number, rate: FrameRate): number {
  const whole = Math.floor(t + 1e-9)
  const frames = Math.round((t - whole) * 100)
  return timecodeToSeconds(
    {
      hours: Math.floor(whole / 3600),
      minutes: Math.floor((whole % 3600) / 60),
      seconds: whole % 60,
      frames: Math.min(frames, rate.nominal - 1),
      dropFrame: false,
    },
    rate,
  )!
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0")
}

/** `HH:MM:SS.mmm`, the form a cue's own timestamp line uses. */
function cueTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000))
  return (
    `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor((total % 3_600_000) / 60_000))}:` +
    `${pad(Math.floor((total % 60_000) / 1000))}.${pad(total % 1000, 3)}`
  )
}

const RANGE_AT_START = /^\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[.,]\d{3}/

/**
 * Re-time cues whose times are frames written as hundredths: `00:01:06.150`
 * at 24 fps becomes `00:01:06.625`. Only cue times move — the words, ids,
 * speakers and order stay as they were — and the cue's timestamp label is
 * rewritten to match, cue settings after it kept.
 */
export function convertFramesAsHundredths<T extends TranslatableString>(
  strings: readonly T[],
  label: FrameRateLabel,
): T[] {
  const rate = frameRateFor(label)
  return strings.map((s) => {
    if (typeof s.start !== "number" || typeof s.end !== "number") return s
    const start = framesAsHundredthsToSeconds(s.start, rate)
    const end = framesAsHundredthsToSeconds(s.end, rate)
    const range = `${cueTime(start)} --> ${cueTime(end)}`
    const context = typeof s.context === "string" && RANGE_AT_START.test(s.context)
      ? s.context.replace(RANGE_AT_START, range)
      : s.context
    return { ...s, start, end, context }
  })
}
