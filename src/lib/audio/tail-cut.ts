// AQU-1767: a dub that ends exactly where its trim says, by construction —
// and a split take's pieces joined into one clip, for Free timing.
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
  if (!(endSec > 0)) return null
  // A header written before the length was known says 0 or 0xFFFFFFFF;
  // wavLayout reads the audio as running to the end of the bytes then.
  const w = wavLayout(bytes)
  if (!w) return null
  const keep = Math.min(w.dataBytes, Math.round(endSec * w.sampleRate) * w.blockAlign)
  if (keep <= 0 || keep >= w.dataBytes) return null
  const out = bytes.slice(0, w.dataStart + keep)
  const odv = new DataView(out.buffer)
  odv.setUint32(4, out.length - 8, true)
  odv.setUint32(w.sizeAt, keep, true)
  return out
}

/** Where a PCM WAV's audio sits: its header bytes, and its frames' size and rate. */
function wavLayout(bytes: Uint8Array): { dataStart: number; dataBytes: number; sizeAt: number; sampleRate: number; blockAlign: number; pcm16: boolean } | null {
  if (bytes.length < 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sampleRate = 0
  let blockAlign = 0
  let pcm16 = false
  for (let off = 12; off + 8 <= bytes.length; ) {
    const id = tag(bytes, off)
    const size = dv.getUint32(off + 4, true)
    if (id === "fmt ") {
      if (off + 24 > bytes.length) return null
      sampleRate = dv.getUint32(off + 12, true)
      blockAlign = dv.getUint16(off + 20, true)
      // AQU-2432: 16-bit integer PCM (plain, or extensible) can be mixed by bytes.
      const format = dv.getUint16(off + 8, true)
      pcm16 = (format === 1 || format === 0xfffe) && dv.getUint16(off + 22, true) === 16
    } else if (id === "data") {
      if (!sampleRate || !blockAlign) return null
      const dataStart = off + 8
      const declared = size === 0 || size === 0xffffffff ? bytes.length - dataStart : size
      const avail = Math.min(declared, bytes.length - dataStart)
      return { dataStart, dataBytes: avail - (avail % blockAlign), sizeAt: off + 4, sampleRate, blockAlign, pcm16 }
    }
    off += 8 + size + (size & 1)
  }
  return null
}

/** A span of a recording to join, and the silence to put before it. */
export interface JoinSpan {
  start: number
  end: number
  /** AQU-1758: silence before this span, in seconds — a gap someone dragged
   *  open between two pieces of a take. Absent: the spans touch. */
  gapBeforeSec?: number
  /** AQU-2432 (Sam, Nov 6): this span starts this long before the end of the
   *  span before it — a piece dragged over the end of the piece in front —
   *  and the two are MIXED there, both at full volume. */
  overlapBeforeSec?: number
}

/** Where each span starts in the joined clip, in frames (`rate`), and how
 *  long the clip is: each one `gapBeforeSec` after the end of the one before
 *  it, or `overlapBeforeSec` before it (AQU-2432); the clip lasts to whichever
 *  ends last. */
function spanPlaces(spans: readonly JoinSpan[], rate: number, framesOf: (i: number) => number): { at: number[]; total: number } {
  const at: number[] = []
  let prevEnd = 0
  let total = 0
  spans.forEach((s, i) => {
    const gap = s.gapBeforeSec != null && s.gapBeforeSec > 0 ? Math.round(s.gapBeforeSec * rate) : 0
    const overlap = s.overlapBeforeSec != null && s.overlapBeforeSec > 0 ? Math.round(s.overlapBeforeSec * rate) : 0
    const start = Math.max(0, prevEnd + gap - overlap)
    at.push(start)
    prevEnd = start + framesOf(i)
    total = Math.max(total, prevEnd)
  })
  return { at, total }
}

/**
 * A PCM WAV's audio between each span's start and end (seconds on its own
 * clock), joined in the order given into one WAV of the same format, with
 * each span's `gapBeforeSec` of silence before it. Null when it is not a WAV
 * this can read or a span is empty.
 */
export function joinWavSpans(bytes: Uint8Array, spans: readonly JoinSpan[]): Uint8Array | null {
  const w = wavLayout(bytes)
  if (!w || spans.length === 0) return null
  // AQU-2432: spans that overlap are mixed — by bytes for 16-bit PCM, else
  // by the decode path (null here).
  if (spans.some((s) => (s.overlapBeforeSec ?? 0) > 0)) return w.pcm16 ? mixWavSpans16(bytes, w, spans) : null
  const ranges: [number, number, number][] = []
  let total = 0
  for (const s of spans) {
    const a = Math.min(w.dataBytes, Math.max(0, Math.round(s.start * w.sampleRate)) * w.blockAlign)
    const b = Math.min(w.dataBytes, Math.max(0, Math.round(s.end * w.sampleRate)) * w.blockAlign)
    if (b <= a) return null
    const gap = s.gapBeforeSec != null && s.gapBeforeSec > 0 ? Math.round(s.gapBeforeSec * w.sampleRate) * w.blockAlign : 0
    ranges.push([a, b, gap])
    total += gap + b - a
  }
  // Zero bytes are silence for 16-, 24- and 32-bit PCM and for float, which
  // is every WAV the recorder and the generators write.
  const out = new Uint8Array(w.dataStart + total)
  out.set(bytes.subarray(0, w.dataStart))
  let at = w.dataStart
  for (const [a, b, gap] of ranges) {
    at += gap
    out.set(bytes.subarray(w.dataStart + a, w.dataStart + b), at)
    at += b - a
  }
  const odv = new DataView(out.buffer)
  odv.setUint32(4, out.length - 8, true)
  odv.setUint32(w.sizeAt, total, true)
  return out
}

/**
 * AQU-2432: `joinWavSpans` for spans that overlap, on 16-bit PCM: every span
 * summed into place, sample by sample, held at full scale — both pieces at
 * full volume where they overlap, the rest as it was.
 */
function mixWavSpans16(
  bytes: Uint8Array,
  w: { dataStart: number; dataBytes: number; sizeAt: number; sampleRate: number; blockAlign: number },
  spans: readonly JoinSpan[],
): Uint8Array | null {
  const ranges: [number, number][] = []
  for (const s of spans) {
    const a = Math.min(w.dataBytes, Math.max(0, Math.round(s.start * w.sampleRate)) * w.blockAlign)
    const b = Math.min(w.dataBytes, Math.max(0, Math.round(s.end * w.sampleRate)) * w.blockAlign)
    if (b <= a) return null
    ranges.push([a, b])
  }
  const { at, total } = spanPlaces(spans, w.sampleRate, (i) => (ranges[i][1] - ranges[i][0]) / w.blockAlign)
  const out = new Uint8Array(w.dataStart + total * w.blockAlign)
  out.set(bytes.subarray(0, w.dataStart))
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dst = new DataView(out.buffer)
  ranges.forEach(([a, b], i) => {
    const to = w.dataStart + at[i] * w.blockAlign
    for (let k = 0; k + 1 < b - a; k += 2) {
      const sum = dst.getInt16(to + k, true) + src.getInt16(w.dataStart + a + k, true)
      dst.setInt16(to + k, Math.max(-32768, Math.min(32767, sum)), true)
    }
  })
  const odv = new DataView(out.buffer)
  odv.setUint32(4, out.length - 8, true)
  odv.setUint32(w.sizeAt, total * w.blockAlign, true)
  return out
}

/** Any other format: decoded (no output device opened) to mono, or null. */
async function decodeMono(bytes: Uint8Array): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  const g = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext }
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext
  if (!Ctor) return null
  try {
    const decoded = await new Ctor(1, 1, 48000).decodeAudioData(bytes.slice().buffer)
    const pcm = new Float32Array(decoded.length)
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch)
      for (let i = 0; i < pcm.length; i++) pcm[i] += data[i] / decoded.numberOfChannels
    }
    return { pcm, sampleRate: decoded.sampleRate }
  } catch {
    return null
  }
}

/** Any other format: decoded, cut, re-encoded as WAV. */
async function tailCutDecoded(bytes: Uint8Array, endSec: number): Promise<Blob | null> {
  const d = await decodeMono(bytes)
  if (!d) return null
  const frames = Math.round(endSec * d.sampleRate)
  if (frames <= 0 || frames >= d.pcm.length) return null
  return encodeWavPcm16(d.pcm.subarray(0, frames), d.sampleRate)
}

/**
 * AQU-1767 (Sam, 2026-10-15): a split take as Free timing plays it — its
 * pieces' audio back to back in one clip, so the player never has to skip
 * between them (and so can never overrun into the audio between pieces).
 * A WAV is joined by bytes; any other format is decoded and re-encoded.
 */
export async function joinedClip(bytes: Uint8Array, ext: string, spans: readonly JoinSpan[]): Promise<Blob | null> {
  if (ext.toLowerCase() === "wav") {
    const joined = joinWavSpans(bytes, spans)
    if (joined) return new Blob([joined as BlobPart], { type: "audio/wav" })
  }
  const d = await decodeMono(bytes)
  if (!d) return null
  const parts = spans.map((s) =>
    d.pcm.subarray(
      Math.max(0, Math.round(s.start * d.sampleRate)),
      Math.min(d.pcm.length, Math.round(s.end * d.sampleRate)),
    ),
  )
  // AQU-2432: overlapping spans are summed where they overlap.
  const { at, total } = spanPlaces(spans, d.sampleRate, (i) => parts[i].length)
  const out = new Float32Array(total)
  parts.forEach((pcm, i) => {
    for (let k = 0; k < pcm.length; k++) out[at[i] + k] += pcm[k]
  })
  return out.length > 0 ? encodeWavPcm16(out, d.sampleRate) : null
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

/** Any other format, decoded whole and re-encoded as WAV: a clip that can be seeked. */
async function wavOfDecoded(bytes: Uint8Array): Promise<Blob | null> {
  const d = await decodeMono(bytes)
  return d && d.pcm.length > 0 ? encodeWavPcm16(d.pcm, d.sampleRate) : null
}

/**
 * AQU-1767 (Sam's walk, 2026-10-15): the clip as a dub that must START partway
 * in can play it — a WAV, cut at `endSec` when given. A webm states no length
 * (a recording, or a take cleaned by Remove noise), and the queue rightly will
 * not seek one, so every piece but a split take's first played from the
 * recording's head. Awaited — the dub is due, but a few milliseconds late
 * beats the wrong words — and cached, so it is paid once per piece. A WAV is
 * already seekable: null unless it needs cutting (tailCutNow does that).
 */
export async function seekableClip(audioId: string, ext: string, bytes: Uint8Array, endSec: number | null): Promise<Blob | null> {
  if (ext.toLowerCase() === "wav") return endSec != null ? tailCutNow(audioId, ext, bytes, endSec) : null
  if (endSec != null && endSec > TAIL_CUT_MAX_SEC) return null
  const key = endSec != null ? `${audioId}.${ext}@${Math.round(endSec * 1000)}` : `${audioId}.${ext}@whole`
  const hit = cache.get(key)
  if (hit !== undefined) return await hit
  const pending = endSec != null ? tailCutDecoded(bytes, endSec) : wavOfDecoded(bytes)
  remember(key, pending)
  const blob = await pending
  if (cache.get(key) === pending) remember(key, blob)
  return blob
}

export function __resetTailCutForTests(): void {
  cache.clear()
}
