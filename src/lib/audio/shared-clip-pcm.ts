// AQU-1681: transcribe a long shared recording without decoding it once per row.
//
// An imported recording — and now a linked video's own sound — is ONE clip
// shared by every row it was cut into, and each row transcribes only its trim
// window. That window used to be cut from a fresh decode of the WHOLE clip,
// row after row: for a 55-minute episode cut into ~800 rows, 800 decodes of 55
// minutes (3.3 s and a 420 MB buffer each, measured in Chrome on episode 101's
// sound) — some 45 minutes of decoding behind one auto-transcribe, with two
// of those buffers alive at once.
//
// So a batch decodes the clip once, keeps its 16 kHz mono PCM (≈210 MB for 55
// minutes, half of what every row used to allocate for itself), and cuts each
// row's window out of that. One clip at a time, and dropped after a minute
// without use so the memory goes back when the batch is done.

import { resolvePcmWindow, type PcmTrimWindow } from "./pcm-window"

/** Rate of the PCM held here — Whisper's. */
const SAMPLE_RATE = 16_000

/** How long the PCM outlives its last use. Rows of one batch follow each
 *  other within seconds; a minute covers a slow hosted request. */
export const SHARED_CLIP_IDLE_MS = 60_000

let held: { key: string; pcm: Promise<Float32Array> } | null = null
let releaseTimer: ReturnType<typeof setTimeout> | null = null

/** Is this clip already decoded (or being decoded)? A caller can then skip
 *  reading its bytes at all. */
export function hasSharedClipPcm(key: string): boolean {
  return held?.key === key
}

/** Forget the held clip now. */
export function releaseSharedClipPcm(): void {
  held = null
  if (releaseTimer !== null) clearTimeout(releaseTimer)
  releaseTimer = null
}

function keepAlive(): void {
  if (releaseTimer !== null) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(releaseSharedClipPcm, SHARED_CLIP_IDLE_MS)
}

/**
 * One row's window of a shared clip, as 16 kHz mono PCM.
 *
 * `loadBytes` and `decode` run only when this clip is not already held; two
 * rows asking at once share the one decode. The window is always a COPY: the
 * Whisper hand-off transfers the buffer it is given, which would otherwise
 * detach the held clip under every later row.
 */
export async function sharedClipWindow(
  key: string,
  trim: PcmTrimWindow,
  loadBytes: () => Uint8Array | Promise<Uint8Array>,
  decode: (bytes: Uint8Array) => Promise<Float32Array>,
): Promise<Float32Array> {
  let entry = held
  if (entry?.key !== key) {
    const pcm = Promise.resolve().then(loadBytes).then(decode)
    const created = { key, pcm }
    entry = held = created
    pcm.catch(() => {
      if (held === created) releaseSharedClipPcm()
    })
  }
  const whole = await entry.pcm
  keepAlive()
  const win = resolvePcmWindow(whole.length, SAMPLE_RATE, trim)
  return whole.slice(win.start, win.end)
}
