// What to play, and when — the arithmetic behind previewing one clip.
// (AQU-646 stage 5)
//
// Split from the engine for the reason `pcm-window.ts` states beside its own
// decode: the Web Audio half is browser-only, but the sums that decide WHICH
// slice of a clip is heard are ordinary arithmetic and get to be tested. Every
// number below is one somebody may want to turn, so each says what it is for.

import type { TargetChipGeom } from "@/lib/timeline/lane-timing"

/** One grain. Below ~40ms speech is a buzz with no vowel left in it; above
 *  ~150ms the grains lag the hand and the tape metaphor breaks. */
export const GRAIN_SEC = 0.08

/** How often a grain fires while the hand is moving. ~25% overlap at
 *  GRAIN_SEC, which is what keeps a run of them sounding continuous. */
export const GRAIN_PERIOD_MS = 60

/**
 * How long after the last pointer movement the grains keep going.
 *
 * WITHOUT THIS IT IS A DRONE. Parked on a handle — which is most of a careful
 * trim, while you decide — a fixed interval would repeat the same 80ms
 * forever. Grains answer "what is under the edge as I move it"; when nothing
 * is moving there is no question being asked.
 */
export const GRAIN_IDLE_MS = 250

/**
 * The fade on each end of a grain. NOT polish: a raw slice starts and stops
 * mid-waveform, and that step is a click — sixteen times a second. 5ms is
 * below the ear's pitch threshold, so it removes the click without being
 * heard as a fade.
 */
export const GRAIN_FADE_SEC = 0.005

/** Start each grain a hair in the future: scheduling exactly at
 *  `ctx.currentTime` can land in the past by the time the graph runs it, which
 *  truncates the fade-in and reintroduces the click it exists to remove. */
export const GRAIN_SCHEDULE_AHEAD_SEC = 0.005

/** A ceiling on live grain nodes, not a working value. At GRAIN_PERIOD_MS
 *  against GRAIN_SEC there are never more than two; this is the guard against
 *  an event storm creating nodes faster than they end. */
export const MAX_LIVE_GRAINS = 4

/**
 * The longest clip this will decode.
 *
 * A DECODED BUFFER IS MUCH BIGGER THAN ITS FILE. 48kHz stereo Float32 is
 * 384KB per second — an hour is 1.4GB, and the recorder's own upload control
 * accepts a 100MB file as a take. 120s is ~46MB worst case, which is generous
 * for any spoken line while leaving an attached long-form file to the element
 * path, where its honest duration metadata makes seeking safe.
 */
export const PREVIEW_MAX_DECODE_SEC = 120

/** …and the same ceiling in bytes, for a clip whose length was never measured
 *  (a durationless webm that nobody has healed). Compressed audio expands, so
 *  this is deliberately far below the decoded budget. */
export const PREVIEW_MAX_DECODE_BYTES = 12 * 1024 * 1024

/** How much decoded audio to keep across clips. Byte-budgeted, not
 *  count-budgeted: four entries means nothing when one of them can be a
 *  gigabyte. */
export const PREVIEW_BUFFER_BUDGET_BYTES = 64 * 1024 * 1024

/**
 * The slice the play button plays: the clip AS THE TIMELINE DRAWS IT.
 *
 * In the clip's own clock, not the file's — `trimStartSec` and `trimEndSec` are
 * already offsets into the audio, which is what an `AudioBufferSourceNode`
 * wants. A null end means "to the natural end of the clip", which is both the
 * untrimmed case and the one where the length was never measured.
 */
export function previewWindowForGeom(geom: TargetChipGeom): {
  startSec: number
  endSec: number | null
} {
  const startSec = Number.isFinite(geom.trimStartSec) ? Math.max(0, geom.trimStartSec) : 0
  // `usingFallback` means the chip's width came from its section rather than
  // from the audio, so its end says nothing about where the sound stops.
  const endSec =
    !geom.usingFallback && geom.trimEndSec != null && Number.isFinite(geom.trimEndSec)
      ? Math.max(startSec, geom.trimEndSec)
      : null
  return { startSec, endSec }
}

/**
 * The slice a grain plays, which depends on WHICH EDGE is being dragged.
 *
 * THE ASYMMETRY IS THE FEATURE. Trimming, the question is always "does the
 * word survive this cut":
 *   - the IN point keeps what comes after it, so play forward from the edge;
 *   - the OUT point keeps what comes before it, so play up TO the edge.
 * Playing forward from an out-point would audition the material being thrown
 * away — an answer to a question nobody asked.
 *
 * Null when the window has no length left, which happens at either end of the
 * clip; the caller makes no sound rather than a zero-length node.
 */
export function grainWindow(
  posClipSec: number,
  edge: "in" | "out",
  bufferDurSec: number,
  grainSec: number = GRAIN_SEC,
): { offsetSec: number; durationSec: number } | null {
  if (!Number.isFinite(posClipSec) || !Number.isFinite(bufferDurSec) || bufferDurSec <= 0) return null
  const wanted = Math.min(grainSec, bufferDurSec)
  const raw = edge === "in" ? posClipSec : posClipSec - wanted
  const offsetSec = Math.min(Math.max(0, raw), bufferDurSec)
  const durationSec = Math.min(wanted, bufferDurSec - offsetSec)
  return durationSec > 0 ? { offsetSec, durationSec } : null
}

/** Fire a grain? Only on the beat, and only while the hand is still moving. */
export function shouldFireGrain(nowMs: number, lastFireMs: number, lastMoveMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false
  if (nowMs - lastMoveMs > GRAIN_IDLE_MS) return false
  return nowMs - lastFireMs >= GRAIN_PERIOD_MS
}

/**
 * Can this clip be decoded, or must it go to the element?
 *
 * The partition is not a hedge, it is a symmetry: the clips that BREAK an
 * element are MediaRecorder webms, which report no duration and whose seeks
 * throw the take away — and those are takes, seconds long and cheap to decode.
 * The clips too big to decode are long attached files, which carry honest
 * duration metadata and therefore seek correctly. Each engine is used exactly
 * where the other is unsafe.
 */
export function canDecodePreview(durationSec: number | null, byteLength?: number): boolean {
  if (durationSec != null && Number.isFinite(durationSec) && durationSec > 0) {
    return durationSec <= PREVIEW_MAX_DECODE_SEC
  }
  // Length never measured — judge by the file, which is all there is.
  if (byteLength == null) return true
  return byteLength <= PREVIEW_MAX_DECODE_BYTES
}
