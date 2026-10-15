// The few facts we need from a fragmented MP4 (fMP4) stream. (AQU-1681)
//
// A streamed film's sound arrives as an init segment plus hundreds of
// fragments. Two questions are answered from their boxes rather than from the
// playlist's rounded `EXTINF` durations:
//
//  • How long is each fragment, exactly? The sound is decoded a minute at a
//    time, and every decoder is free to add or drop a few samples at a chunk's
//    edges (AAC priming). Each chunk is cut back to the length its fragments
//    declare, so those few samples cannot pile up across fifty chunks and
//    slide every later row off the picture. `EXTINF` is not good enough for
//    that: a packager may round it to whole seconds.
//  • Where does each stream's clock start? The rows are timed to the picture,
//    so the sound must start where the picture starts. Each stream's first
//    `tfdt` (in its own timescale) says where.
//
// Read-only and allocation-free beyond the result: a DataView walk over the
// box tree, ignoring every box it does not need.

/** What one track's init segment declares. */
export interface Mp4TrackInfo {
  trackId: number
  /** `hdlr` handler type: "soun", "vide", … */
  handler: string
  /** `mdhd` timescale — ticks per second for every time in this track. */
  timescale: number
  /** `trex` default sample duration, for fragments that state none. */
  defaultSampleDuration: number | null
}

/** What one fragment (or a segment holding several) says about a track. */
export interface Mp4FragmentTiming {
  trackId: number
  /** First `tfdt` in the segment, in the track's timescale. */
  baseMediaDecodeTime: number
  /** Sum of every sample's duration in the segment, in the track's
   *  timescale; null when a run states none and there is no default. */
  durationTicks: number | null
}

interface Box {
  type: string
  /** Offset of the box's payload (after its header). */
  start: number
  /** Offset just past the box. */
  end: number
}

function boxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = []
  let off = start
  while (off + 8 <= end) {
    let size = view.getUint32(off)
    const type = String.fromCharCode(
      view.getUint8(off + 4), view.getUint8(off + 5), view.getUint8(off + 6), view.getUint8(off + 7),
    )
    let header = 8
    if (size === 1) {
      if (off + 16 > end) break
      size = Number(view.getBigUint64(off + 8))
      header = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < header) break
    // A box cut short by the end of what we fetched (a ranged read of a
    // fragment's header) is still worth reading as far as it goes.
    out.push({ type, start: off + header, end: Math.min(off + size, end) })
    off += size
  }
  return out
}

function find(view: DataView, parent: Box | null, type: string): Box | undefined {
  const start = parent ? parent.start : 0
  const end = parent ? parent.end : view.byteLength
  return boxes(view, start, end).find((b) => b.type === type)
}

function children(view: DataView, parent: Box, type: string): Box[] {
  return boxes(view, parent.start, parent.end).filter((b) => b.type === type)
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * The tracks an fMP4 init segment declares. Empty when it is not one (no
 * `moov`), which callers treat as "cannot tell".
 */
export function readInitTracks(bytes: Uint8Array): Mp4TrackInfo[] {
  const view = viewOf(bytes)
  const moov = find(view, null, "moov")
  if (!moov) return []
  const defaults = new Map<number, number>()
  const mvex = find(view, moov, "mvex")
  if (mvex) {
    for (const trex of children(view, mvex, "trex")) {
      if (trex.end - trex.start < 24) continue
      defaults.set(view.getUint32(trex.start + 4), view.getUint32(trex.start + 12))
    }
  }
  const out: Mp4TrackInfo[] = []
  for (const trak of children(view, moov, "trak")) {
    const tkhd = find(view, trak, "tkhd")
    const mdia = find(view, trak, "mdia")
    const mdhd = mdia && find(view, mdia, "mdhd")
    const hdlr = mdia && find(view, mdia, "hdlr")
    if (!tkhd || !mdhd || !hdlr) continue
    const trackId = view.getUint8(tkhd.start) === 1
      ? view.getUint32(tkhd.start + 4 + 16)
      : view.getUint32(tkhd.start + 4 + 8)
    const timescale = view.getUint8(mdhd.start) === 1
      ? view.getUint32(mdhd.start + 4 + 16)
      : view.getUint32(mdhd.start + 4 + 8)
    const handler = String.fromCharCode(
      view.getUint8(hdlr.start + 8), view.getUint8(hdlr.start + 9),
      view.getUint8(hdlr.start + 10), view.getUint8(hdlr.start + 11),
    )
    if (!(timescale > 0)) continue
    out.push({ trackId, handler, timescale, defaultSampleDuration: defaults.get(trackId) ?? null })
  }
  return out
}

/**
 * Per-track timing of one media segment: its first `tfdt` and the summed
 * duration of its samples. A segment may hold several `moof`s; all count.
 * `tracks` supplies the `trex` defaults for runs that state no duration.
 */
export function readFragmentTiming(bytes: Uint8Array, tracks: readonly Mp4TrackInfo[]): Mp4FragmentTiming[] {
  const view = viewOf(bytes)
  const byTrack = new Map<number, Mp4FragmentTiming>()
  for (const moof of boxes(view, 0, view.byteLength).filter((b) => b.type === "moof")) {
    for (const traf of children(view, moof, "traf")) {
      const tfhd = find(view, traf, "tfhd")
      if (!tfhd || tfhd.end - tfhd.start < 8) continue
      const tfhdFlags = view.getUint32(tfhd.start) & 0xffffff
      const trackId = view.getUint32(tfhd.start + 4)
      let p = tfhd.start + 8
      if (tfhdFlags & 0x01) p += 8 // base-data-offset
      if (tfhdFlags & 0x02) p += 4 // sample-description-index
      const trafDefault = tfhdFlags & 0x08 ? view.getUint32(p) : null
      const fallback = trafDefault ?? tracks.find((t) => t.trackId === trackId)?.defaultSampleDuration ?? null

      const tfdt = find(view, traf, "tfdt")
      const decodeTime = tfdt
        ? view.getUint8(tfdt.start) === 1
          ? Number(view.getBigUint64(tfdt.start + 4))
          : view.getUint32(tfdt.start + 4)
        : null

      let duration: number | null = 0
      for (const trun of children(view, traf, "trun")) {
        const flags = view.getUint32(trun.start) & 0xffffff
        const count = view.getUint32(trun.start + 4)
        if (!(flags & 0x100)) {
          duration = duration === null || fallback === null ? null : duration + count * fallback
          continue
        }
        let q = trun.start + 8
        if (flags & 0x01) q += 4 // data-offset
        if (flags & 0x04) q += 4 // first-sample-flags
        const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length
        let sum = 0
        for (let i = 0; i < count && q + 4 <= trun.end; i += 1, q += stride) sum += view.getUint32(q)
        duration = duration === null ? null : duration + sum
      }

      const prior = byTrack.get(trackId)
      if (prior) {
        prior.durationTicks = prior.durationTicks === null || duration === null ? null : prior.durationTicks + duration
      } else if (decodeTime !== null) {
        byTrack.set(trackId, { trackId, baseMediaDecodeTime: decodeTime, durationTicks: duration })
      }
    }
  }
  return [...byTrack.values()]
}

/** Where a segment's first sample sits on its track's clock, in seconds. */
export function fragmentStartSec(init: Uint8Array, fragment: Uint8Array, handler: string): number | null {
  const tracks = readInitTracks(init)
  const track = tracks.find((t) => t.handler === handler) ?? tracks[0]
  if (!track) return null
  const timing = readFragmentTiming(fragment, tracks).find((f) => f.trackId === track.trackId)
  return timing ? timing.baseMediaDecodeTime / track.timescale : null
}
