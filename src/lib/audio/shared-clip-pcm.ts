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
//
// A linked video's sound is better still: it was already decoded at 16 kHz, a
// minute at a time, to find its pauses, so that PCM is handed over here
// (`primeSharedClipPcm`) and the clip is never decoded whole at all. That is
// not only cheaper. Safari's `decodeAudioData` stops short on a long file —
// measured on episode 101's 52 MB copy, it returned 35 of its 55 minutes —
// so every row past that point would otherwise have nothing to transcribe.

import { resolvePcmWindow, type PcmTrimWindow } from "./pcm-window"

/** Rate of the PCM held here — Whisper's. */
const SAMPLE_RATE = 16_000

/** How long the PCM outlives its last use. Rows of one batch follow each
 *  other within seconds; a minute covers a slow hosted request. */
export const SHARED_CLIP_IDLE_MS = 60_000

/** How long a primed clip waits for its first row. The batch starts only
 *  once every row has reached the server, which takes minutes for an
 *  episode's ~900 rows. */
export const SHARED_CLIP_PRIMED_MS = 10 * 60_000

let held: { key: string; pcm: Promise<Float32Array> } | null = null
let releaseTimer: ReturnType<typeof setTimeout> | null = null
/** Batches running now (see `pinSharedClipPcm`). */
let pins = 0

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

function keepAlive(ms = SHARED_CLIP_IDLE_MS): void {
  if (releaseTimer !== null) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(releaseIfIdle, ms)
}

function releaseIfIdle(): void {
  if (pins > 0) keepAlive()
  else releaseSharedClipPcm()
}

/**
 * AQU-1681: keep the held clip for as long as a batch runs, however long it
 * goes without a row. A batch that meets the hosted limit sits out up to a
 * quarter of an hour; letting the clip go meanwhile meant downloading the
 * whole recording and decoding it again afterwards — measured at a 6 GB tab
 * on a 55-minute episode, and in Safari a decode that stops short. Returns
 * the unpin; the usual minute's grace starts from it.
 */
export function pinSharedClipPcm(): () => void {
  pins += 1
  let done = false
  return () => {
    if (done) return
    done = true
    pins -= 1
    if (pins === 0 && held) keepAlive()
  }
}

/** Hold a clip's 16 kHz mono PCM that was decoded some other way, so its
 *  rows never decode it. Replaces whatever clip was held. */
export function primeSharedClipPcm(key: string, pcm: Float32Array): void {
  held = { key, pcm: Promise.resolve(pcm) }
  keepAlive(SHARED_CLIP_PRIMED_MS)
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
  // A row that starts past the end of what decoded (a decode that stopped
  // short) has nothing to transcribe. The window rule below would hand it
  // the WHOLE clip instead — an hour of audio per row, to a paid service.
  const startSample = Math.round(((trim.trimStartMs ?? 0) / 1000) * SAMPLE_RATE)
  if (whole.length > 0 && startSample >= whole.length) {
    console.warn(`[transcribe] AQU-1681: ${key} decoded to ${whole.length / SAMPLE_RATE}s; a row at ${startSample / SAMPLE_RATE}s has no audio`)
    return new Float32Array(0)
  }
  const win = resolvePcmWindow(whole.length, SAMPLE_RATE, trim)
  return whole.slice(win.start, win.end)
}
