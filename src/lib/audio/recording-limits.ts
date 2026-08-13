// How long a take may run, per capture format, derived from the upload cap.
//
// Uncompressed WAV is ~3× the bytes of the webm/opus takes the recorder used
// to produce exclusively: 48 kHz mono 16-bit is 96,000 B/s, so the 95 MiB
// upload ceiling lands at 17m18s — against a recorder that allowed 30 minutes.
// Rather than restate a number in a comment ("keep the two in sync", as
// upload.ts does with the worker), every limit here is COMPUTED from
// MAX_AUDIO_UPLOAD_BYTES, so raising or lowering the cap moves the recorder
// with it.
//
// The hard stop is expressed in frames as well as milliseconds because the
// WAV path counts frames, not wall clock: frame count is immune to
// background-tab timer throttling and it is the number that actually
// determines the file size.

import { MAX_AUDIO_UPLOAD_BYTES } from "./upload"
import { WAV_HEADER_BYTES } from "./wav-encode"

// Re-exported so the size arithmetic here and the encoder can never disagree
// about how many bytes the header costs.
export { WAV_HEADER_BYTES }

/** Rate we ask the capture context for. The context may refuse it (Firefox),
 *  which is why the WAV header is written from the context's REAL rate — see
 *  pcm-capture.ts. A real rate below this only makes the limits below
 *  conservative, never unsafe. */
export const WAV_SAMPLE_RATE = 48000

/** Mono 16-bit at WAV_SAMPLE_RATE. */
export const WAV_BYTES_PER_SEC = WAV_SAMPLE_RATE * 2

/** webm/opus at the 256 kbps useAudioRecorder asks MediaRecorder for. Opus is
 *  VBR so this is an upper bound, which is the safe direction for a cap. */
const WEBM_BYTES_PER_SEC = 256_000 / 8

/** Headroom under the upload cap: the container overhead, a sample rate that
 *  is not exactly 48 kHz, and the fact that a take rejected at PUT time is a
 *  take lost after the operator already performed it. */
const UPLOAD_SAFETY_FRACTION = 0.9

export type RecordingFormat = "wav" | "webm"

export interface RecordingLimits {
  /** Elapsed ms after which the UI warns the take is getting long. */
  warnMs: number
  /** Elapsed ms at which capture stops itself. */
  hardStopMs: number
  /** hardStopMs as a sample count at WAV_SAMPLE_RATE. Only the WAV path uses
   *  it — MediaRecorder never tells us how many frames it has swallowed. */
  maxFrames: number
}

// Per-format ceilings before the byte cap is applied. webm's 25/30 are the
// values the recorder has always used and must keep: choosing the compressed
// format has to change nothing else about how the recorder behaves.
const FORMAT_CEILINGS = {
  wav: { warnMs: 12 * 60 * 1000, hardStopMs: 15 * 60 * 1000, bytesPerSec: WAV_BYTES_PER_SEC, headerBytes: WAV_HEADER_BYTES },
  webm: { warnMs: 25 * 60 * 1000, hardStopMs: 30 * 60 * 1000, bytesPerSec: WEBM_BYTES_PER_SEC, headerBytes: 0 },
} as const

export interface RecordingLimitOptions {
  /** Tighter byte budget than the upload cap — the voice-clone reference has
   *  its own, and checking it after the take is over is a late failure. */
  maxBytes?: number
}

export function recordingLimitsFor(
  format: RecordingFormat,
  opts?: RecordingLimitOptions,
): RecordingLimits {
  const ceiling = FORMAT_CEILINGS[format]
  const budget = opts?.maxBytes ?? MAX_AUDIO_UPLOAD_BYTES
  const byteLimitMs =
    (Math.max(0, budget * UPLOAD_SAFETY_FRACTION - ceiling.headerBytes) / ceiling.bytesPerSec) * 1000
  const hardStopMs = Math.floor(Math.min(ceiling.hardStopMs, byteLimitMs))
  // The warning keeps its share of whatever window survived the byte cap, so
  // a tight maxBytes still warns before it stops rather than at the same
  // instant. At the default cap this is exactly the ceiling pair above.
  const warnMs = Math.floor(
    Math.min(ceiling.warnMs, hardStopMs * (ceiling.warnMs / ceiling.hardStopMs)),
  )
  return { warnMs, hardStopMs, maxFrames: Math.floor((hardStopMs / 1000) * WAV_SAMPLE_RATE) }
}

/** Milliseconds of WAV audio a byte budget holds, header included. */
export function wavMsForBytes(bytes: number): number {
  return Math.floor((Math.max(0, bytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_SEC) * 1000)
}
