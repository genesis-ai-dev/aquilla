// Test fixture: a synthetic fragmented MP4 (fMP4) stream, box for box the
// shape of the client's HLS audio renditions (AQU-1681) — an init segment
// (`ftyp` + `moov` with `mvhd`/`trak`/`mvex`) and fragments (`moof` with
// `mfhd`/`traf(tfhd, tfdt, trun)` + `mdat`).
//
// Each fragment's `mdat` carries one byte: its LEVEL (0 = silence, 1 =
// speech). A stub decoder reads the boxes back and renders that level for the
// fragment's declared duration — what a real decoder does, with none of the
// codec.
//
// Not shipped behaviour; kept beside the code it exercises.

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(payload)
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, 8 + body.byteLength)
  for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i)
  return concat([head, body])
}

/** version (1 byte) + flags (3 bytes). */
function fullBoxHeader(version: number, flags: number): Uint8Array {
  return u32(((version & 0xff) << 24) | (flags & 0xffffff))
}

export interface InitOptions {
  trackId?: number
  handler?: "soun" | "vide"
  timescale: number
  /** `trex` default sample duration. */
  defaultSampleDuration?: number
  /** Write `tkhd`/`mdhd` as version 1 (64-bit times). */
  version1?: boolean
}

export function buildInit(opts: InitOptions): Uint8Array<ArrayBuffer> {
  const trackId = opts.trackId ?? 1
  const v1 = opts.version1 === true
  const tkhd = box(
    "tkhd",
    fullBoxHeader(v1 ? 1 : 0, 3),
    ...(v1 ? [u64(0), u64(0)] : [u32(0), u32(0)]),
    u32(trackId),
    new Uint8Array(v1 ? 68 : 64),
  )
  const mdhd = box(
    "mdhd",
    fullBoxHeader(v1 ? 1 : 0, 0),
    ...(v1 ? [u64(0), u64(0)] : [u32(0), u32(0)]),
    u32(opts.timescale),
    v1 ? u64(0) : u32(0),
    new Uint8Array(4),
  )
  const hdlr = box(
    "hdlr",
    fullBoxHeader(0, 0),
    u32(0),
    new Uint8Array([...(opts.handler ?? "soun")].map((c) => c.charCodeAt(0))),
    new Uint8Array(13),
  )
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf")))
  const trex = box(
    "trex",
    fullBoxHeader(0, 0),
    u32(trackId),
    u32(1),
    u32(opts.defaultSampleDuration ?? 0),
    u32(0),
    u32(0),
  )
  return concat([
    box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x36])),
    box("moov", box("mvhd", fullBoxHeader(0, 0), new Uint8Array(96)), trak, box("mvex", trex)),
  ])
}

export interface FragmentOptions {
  trackId?: number
  /** `tfdt` baseMediaDecodeTime, in the track's timescale. */
  decodeTime: number
  sampleCount: number
  /** Written into `tfhd` when given; otherwise the `trex` default applies. */
  sampleDuration?: number
  /** Per-sample durations in the `trun` instead (overrides the above). */
  perSampleDurations?: number[]
  /** 0 = silence, 1 = speech. */
  level: number
  /** Write `tfdt` as version 1 (64-bit). */
  version1?: boolean
}

export function buildFragment(opts: FragmentOptions): Uint8Array<ArrayBuffer> {
  const trackId = opts.trackId ?? 1
  const tfhdFlags = 0x20000 | (opts.sampleDuration !== undefined ? 0x08 : 0)
  const tfhd = box(
    "tfhd",
    fullBoxHeader(0, tfhdFlags),
    u32(trackId),
    ...(opts.sampleDuration !== undefined ? [u32(opts.sampleDuration)] : []),
  )
  const v1 = opts.version1 === true
  const tfdt = box("tfdt", fullBoxHeader(v1 ? 1 : 0, 0), v1 ? u64(opts.decodeTime) : u32(opts.decodeTime))
  const per = opts.perSampleDurations
  const trun = per
    ? box("trun", fullBoxHeader(0, 0x01 | 0x100 | 0x200), u32(per.length), u32(0),
      ...per.flatMap((d) => [u32(d), u32(1)]))
    : box("trun", fullBoxHeader(0, 0x01), u32(opts.sampleCount), u32(0))
  return concat([
    box("styp", new Uint8Array([0x6d, 0x73, 0x64, 0x68])),
    box("moof", box("mfhd", fullBoxHeader(0, 0), u32(1)), box("traf", tfhd, tfdt, trun)),
    box("mdat", new Uint8Array([opts.level])),
  ])
}

/**
 * Stub decoder: walk the concatenated init + fragments, and render each
 * fragment's level for its declared duration at `sampleRate`. `extraSamples`
 * is appended to every decode, like a decoder that pads a chunk's edge.
 */
export function decodeFixture(
  bytes: ArrayBuffer,
  sampleRate: number,
  timescale: number,
  defaultSampleDuration: number,
  extraSamples = 0,
): Float32Array {
  const view = new DataView(bytes)
  const out: number[] = []
  let duration = 0
  let off = 0
  while (off + 8 <= view.byteLength) {
    const size = view.getUint32(off)
    const type = String.fromCharCode(...new Uint8Array(bytes, off + 4, 4))
    if (type === "moof") {
      // moof > mfhd(16) > traf header(8) > tfhd
      const tfhdAt = off + 8 + 16 + 8
      const flags = view.getUint32(tfhdAt + 8) & 0xffffff
      const tfhdSize = view.getUint32(tfhdAt)
      const trafDefault = flags & 0x08 ? view.getUint32(tfhdAt + 16) : defaultSampleDuration
      const tfdtSize = view.getUint32(tfhdAt + tfhdSize)
      const trunAt = tfhdAt + tfhdSize + tfdtSize
      const trunFlags = view.getUint32(trunAt + 8) & 0xffffff
      const count = view.getUint32(trunAt + 12)
      if (trunFlags & 0x100) {
        duration = 0
        for (let i = 0; i < count; i += 1) duration += view.getUint32(trunAt + 20 + i * 8)
      } else {
        duration = count * trafDefault
      }
    } else if (type === "mdat") {
      const level = view.getUint8(off + 8)
      const n = Math.round((duration / timescale) * sampleRate)
      for (let i = 0; i < n; i += 1) out.push(level ? 0.5 : 0)
    }
    off += size
  }
  for (let i = 0; i < extraSamples; i += 1) out.push(0.5)
  return Float32Array.from(out)
}
