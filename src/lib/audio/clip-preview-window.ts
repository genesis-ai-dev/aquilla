// What to play, and when — the arithmetic behind previewing one clip.
// (AQU-646 stage 5)
//
// Split from the engine for the reason `pcm-window.ts` states beside its own
// decode: the Web Audio half is browser-only, but the sums that decide WHICH
// slice of a clip is heard are ordinary arithmetic and get to be tested. Every
// number below is one somebody may want to turn, so each says what it is for.

import type { TargetChipGeom } from "@/lib/timeline/lane-timing"

/**
 * The fade on each end of a previewed clip. NOT polish: a raw slice starts and
 * stops mid-waveform, and that step is a click. 5ms is below the ear's pitch
 * threshold, so it removes the click without being heard as a fade.
 *
 * Named for grains until 2026-08-28, when the trim-handle tape noises were
 * removed outright — the play button's own clip is the only thing faded now.
 */
export const CLIP_FADE_SEC = 0.005

/** Start playback a hair in the future: scheduling exactly at
 *  `ctx.currentTime` can land in the past by the time the graph runs it, which
 *  truncates the fade-in and reintroduces the click it exists to remove. */
export const SCHEDULE_AHEAD_SEC = 0.005

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
