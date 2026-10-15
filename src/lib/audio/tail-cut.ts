// AQU-1767: a dub that ends exactly where its trim says, by construction.
//
// The timeline stops a trimmed dub with a timer (play-queue's armDubEndStop),
// and a timer fires late whenever the page is busy: measured 60-90ms on a dev
// build, where the workspace re-renders about once a second while it plays. A
// cut falls mid-speech, so that overrun was the next piece's first word, heard
// in the gap and then again (Sam's walk, 2026-10-15). Bytes that END at the
// trim end leave nothing to overrun: the element runs out and stops by itself,
// in the media pipeline, however busy the page is. The HEAD is kept, so the
// element's clock is still the clip's clock and every seek means what it did.

import { encodeWavPcm16 } from "./wav-encode"

/** Longer than this and the clip is not decoded to be cut (the timer stops it). */
export const TAIL_CUT_MAX_SEC = 600

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])

/**
 * A PCM WAV's bytes up to `endSec`, cut on a frame boundary with no decode:
 * every chunk before the audio is kept as it was, the audio stops at the
 * frame nearest `endSec`, and the two sizes are rewritten. Null when it is not
 * a WAV this can read, or when there is nothing after `endSec` to cut.
 */
export function tailCutWav(bytes: Uint8Array, endSec: number): Uint8Array | null {
  if (!(endSec > 0) || bytes.length < 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sampleRate = 0
  let blockAlign = 0
  for (let off = 12; off + 8 <= bytes.length; ) {
    const id = tag(bytes, off)
    const size = dv.getUint32(off + 4, true)
    if (id === "fmt ") {
      if (off + 24 > bytes.length) return null
      sampleRate = dv.getUint32(off + 12, true)
      blockAlign = dv.getUint16(off + 20, true)
    } else if (id === "data") {
      if (!sampleRate || !blockAlign) return null
      const start = off + 8
      // A header written before the length was known says 0 or 0xFFFFFFFF.
      const declared = size === 0 || size === 0xffffffff ? bytes.length - start : size
      const available = Math.min(declared, bytes.length - start)
      const keep = Math.min(available - (available % blockAlign), Math.round(endSec * sampleRate) * blockAlign)
      if (keep <= 0 || keep >= available) return null
      const out = bytes.slice(0, start + keep)
      const odv = new DataView(out.buffer)
      odv.setUint32(4, out.length - 8, true)
      odv.setUint32(off + 4, keep, true)
      return out
    }
    off += 8 + size + (size & 1)
  }
  return null
}

/** Any other format: decoded (no output device opened), cut, re-encoded as WAV. */
async function tailCutDecoded(bytes: Uint8Array, endSec: number): Promise<Blob | null> {
  const g = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext }
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext
  if (!Ctor) return null
  try {
    const decoded = await new Ctor(1, 1, 48000).decodeAudioData(bytes.slice().buffer)
    const frames = Math.round(endSec * decoded.sampleRate)
    if (frames <= 0 || frames >= decoded.length) return null
    const mono = new Float32Array(frames)
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch)
      for (let i = 0; i < frames; i++) mono[i] += data[i] / decoded.numberOfChannels
    }
    return encodeWavPcm16(mono, decoded.sampleRate)
  } catch {
    return null
  }
}

const MAX_CACHED = 32
const cache = new Map<string, Blob | null | Promise<Blob | null>>()

function remember(key: string, value: Blob | null | Promise<Blob | null>): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
}

/**
 * The clip `audioId.ext`, ending at `endSec`, if it is ready NOW. A WAV is cut
 * on the spot. Any other format is cut in the background and answers null
 * until it is ready, so a dub that is due is never held back for a decode:
 * it plays whole that once, stopped by the timer, and exactly from then on.
 * Null too when it cannot be cut; the caller plays the clip as it is.
 */
export function tailCutNow(audioId: string, ext: string, bytes: Uint8Array, endSec: number): Blob | null {
  if (!(endSec > 0) || endSec > TAIL_CUT_MAX_SEC) return null
  const key = `${audioId}.${ext}@${Math.round(endSec * 1000)}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    if (hit instanceof Promise) return null
    remember(key, hit)
    return hit
  }
  if (ext.toLowerCase() === "wav") {
    const cut = tailCutWav(bytes, endSec)
    const blob = cut ? new Blob([cut as BlobPart], { type: "audio/wav" }) : null
    remember(key, blob)
    return blob
  }
  const pending = tailCutDecoded(bytes, endSec)
  remember(key, pending)
  void pending.then((blob) => { if (cache.get(key) === pending) remember(key, blob) })
  return null
}

export function __resetTailCutForTests(): void {
  cache.clear()
}
