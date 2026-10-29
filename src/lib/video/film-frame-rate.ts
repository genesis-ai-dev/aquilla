// The frame rate a linked film runs at. (AQU-2197)
//
// A subtitle file converted from timecode without its frame rate writes each
// frame number as hundredths of a second; converting it back needs the rate,
// and the frame numbers alone cannot tell 24 from 23.976. The film can: an
// HLS master playlist states `FRAME-RATE` on its video variants, an MP4 states
// a sample duration in its `stts`, and a WebM states its `DefaultDuration`.
// Every reader here answers null when it cannot tell, and callers fall back to
// the rate the frame numbers imply.

import { isHlsSource } from "./hls-levels"
import { isMasterPlaylist, parseAttributes } from "./hls-playlist"

/** The most common `FRAME-RATE` across a master playlist's variants. */
export function parseHlsFrameRate(master: string): number | null {
  if (!isMasterPlaylist(master)) return null
  const counts = new Map<number, number>()
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue
    const fps = Number(parseAttributes(line.slice("#EXT-X-STREAM-INF:".length))["FRAME-RATE"])
    if (Number.isFinite(fps) && fps > 0) counts.set(fps, (counts.get(fps) ?? 0) + 1)
  }
  let best: number | null = null
  let bestCount = 0
  for (const [fps, n] of counts) if (n > bestCount) { best = fps; bestCount = n }
  return best
}

interface Box { type: string; start: number; end: number }

function boxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = []
  let off = start
  while (off + 8 <= end) {
    let size = view.getUint32(off)
    const type = String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5), view.getUint8(off + 6), view.getUint8(off + 7))
    let header = 8
    if (size === 1) {
      if (off + 16 > end) break
      size = Number(view.getBigUint64(off + 8))
      header = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < header) break
    out.push({ type, start: off + header, end: Math.min(off + size, end) })
    off += size
  }
  return out
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  return boxes(view, parent.start, parent.end).find((b) => b.type === type)
}

/**
 * The video track's frame rate from an MP4's `moov`: its `mdhd` timescale over
 * the sample duration most of its samples share (`stts`). Null without a
 * `moov` in `bytes`, a video track, or a sample table.
 */
export function parseMp4FrameRate(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const moov = boxes(view, 0, view.byteLength).find((b) => b.type === "moov")
  if (!moov) return null
  for (const trak of boxes(view, moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(view, trak, "mdia")
    const hdlr = mdia && child(view, mdia, "hdlr")
    const mdhd = mdia && child(view, mdia, "mdhd")
    if (!mdia || !hdlr || !mdhd || hdlr.end - hdlr.start < 12) continue
    const handler = String.fromCharCode(view.getUint8(hdlr.start + 8), view.getUint8(hdlr.start + 9), view.getUint8(hdlr.start + 10), view.getUint8(hdlr.start + 11))
    if (handler !== "vide") continue
    const timescale = view.getUint8(mdhd.start) === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12)
    const minf = child(view, mdia, "minf")
    const stbl = minf && child(view, minf, "stbl")
    const stts = stbl && child(view, stbl, "stts")
    if (!stts || !(timescale > 0) || stts.end - stts.start < 16) return null
    const entries = view.getUint32(stts.start + 4)
    let delta = 0
    let most = 0
    for (let i = 0; i < entries && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
      const count = view.getUint32(stts.start + 8 + i * 8)
      const d = view.getUint32(stts.start + 12 + i * 8)
      if (count > most && d > 0) { most = count; delta = d }
    }
    return delta > 0 ? timescale / delta : null
  }
  return null
}

/**
 * A WebM's (Matroska's) video frame rate from its first `DefaultDuration`
 * (element 0x23E383, nanoseconds per frame), which muxers write on the video
 * track. Null when the bytes carry none.
 */
export function parseWebmFrameRate(bytes: Uint8Array): number | null {
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0x23 || bytes[i + 1] !== 0xe3 || bytes[i + 2] !== 0x83) continue
    // EBML size: the leading 1 bit's position gives the length of the size.
    const first = bytes[i + 3]!
    let len = 1
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
    if (len > 8) continue
    let size = first & (0xff >> len)
    for (let k = 1; k < len; k++) size = size * 256 + bytes[i + 3 + k]!
    if (size < 1 || size > 8 || i + 3 + len + size > bytes.length) continue
    let ns = 0
    for (let k = 0; k < size; k++) ns = ns * 256 + bytes[i + 3 + len + k]!
    if (ns > 0) return 1e9 / ns
  }
  return null
}

const HEAD_BYTES = 4 * 1024 * 1024

async function rangeBytes(url: string, range: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Uint8Array | null> {
  const response = await fetchImpl(url, { headers: { Range: range }, signal })
  if (!response.ok) return null
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Read a linked film's frame rate from its URL: the HLS master playlist when
 * it is one, otherwise the head of the file (and its tail, for an MP4 whose
 * `moov` sits at the end). Null on any failure — the caller falls back.
 */
export async function fetchFilmFrameRate(
  url: string,
  { signal, fetchImpl = fetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<number | null> {
  try {
    if (isHlsSource(url)) {
      const response = await fetchImpl(url, { signal })
      return response.ok ? parseHlsFrameRate(await response.text()) : null
    }
    const head = await rangeBytes(url, `bytes=0-${HEAD_BYTES - 1}`, fetchImpl, signal)
    if (!head) return null
    const fromHead = parseMp4FrameRate(head) ?? parseWebmFrameRate(head)
    if (fromHead !== null || head.length < HEAD_BYTES) return fromHead
    const tail = await rangeBytes(url, `bytes=-${HEAD_BYTES}`, fetchImpl, signal)
    if (!tail) return null
    // The tail starts mid-box: find the `moov` header and read from there.
    for (let i = 4; i + 4 <= tail.length; i++) {
      if (tail[i] === 0x6d && tail[i + 1] === 0x6f && tail[i + 2] === 0x6f && tail[i + 3] === 0x76) {
        const fps = parseMp4FrameRate(tail.subarray(i - 4))
        if (fps !== null) return fps
      }
    }
    return null
  } catch {
    return null
  }
}
