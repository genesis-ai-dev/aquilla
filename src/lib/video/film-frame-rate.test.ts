// AQU-2197. WHY: a subtitle file whose frame numbers were written as
// hundredths can only be put right at the frame rate it was timed at, and the
// frame numbers cannot tell 24 from 23.976. The linked film can; these pin
// reading it from each kind of film the app links: an HLS master (the client's
// streams), an MP4, a WebM.

import { describe, expect, it, vi } from "vitest"

import { box } from "./__fixtures__/fmp4"
import { fetchFilmFrameRate, parseHlsFrameRate, parseMp4FrameRate, parseWebmFrameRate } from "./film-frame-rate"

// Episode 101's master (read 2026-10-26), trimmed: every video variant
// states its rate.
const MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="audio_en_fmp4.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=15965367,AVERAGE-BANDWIDTH=4461219,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="SUBTITLE",FRAME-RATE=25.0
video_h264_1280x720_fmp4.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=27147747,AVERAGE-BANDWIDTH=7821763,CODECS="avc1.4D4028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="SUBTITLE",FRAME-RATE=25.0
video_h264_1920x1080_fmp4.m3u8
`

const u32 = (n: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}
const ascii = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)))

/** A `trak` whose sample table says how long each sample lasts. */
function trak(handler: "vide" | "soun", timescale: number, stts: [count: number, delta: number][], v1 = false) {
  const mdhd = v1
    ? box("mdhd", u32(1 << 24), new Uint8Array(16), u32(timescale), new Uint8Array(8), new Uint8Array(4))
    : box("mdhd", u32(0), u32(0), u32(0), u32(timescale), u32(0), new Uint8Array(4))
  const hdlr = box("hdlr", u32(0), u32(0), ascii(handler), new Uint8Array(13))
  const table = box("stts", u32(0), u32(stts.length), ...stts.flatMap(([count, delta]) => [u32(count), u32(delta)]))
  return box("trak", box("tkhd", new Uint8Array(84)), box("mdia", mdhd, hdlr, box("minf", box("stbl", table))))
}

function mp4(...traks: Uint8Array[]) {
  const parts = [box("ftyp", ascii("isom")), box("moov", box("mvhd", new Uint8Array(100)), ...traks)]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

/** Matroska's DefaultDuration (0x23E383), 4-byte payload, nanoseconds per frame. */
function webm(nsPerFrame: number) {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x86, 0x81, 0x01, 0x23, 0xe3, 0x83, 0x84, ...u32(nsPerFrame)])
}

describe("reading a film's frame rate", () => {
  it("reads an HLS master's FRAME-RATE", () => {
    expect(parseHlsFrameRate(MASTER)).toBe(25)
  })

  it("takes the rate most variants state, and nothing from a media playlist", () => {
    const mixed = MASTER + `#EXT-X-STREAM-INF:BANDWIDTH=1,FRAME-RATE=23.976\nlow.m3u8\n`
      + `#EXT-X-STREAM-INF:BANDWIDTH=2,FRAME-RATE=23.976\nlower.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3,FRAME-RATE=23.976\nlowest.m3u8\n`
    expect(parseHlsFrameRate(mixed)).toBe(23.976)
    expect(parseHlsFrameRate("#EXTM3U\n#EXTINF:6.0,\nseg1.m4s\n")).toBeNull()
  })

  it("reads an MP4's video track: its timescale over its usual sample duration", () => {
    expect(parseMp4FrameRate(mp4(trak("vide", 24000, [[1439, 1001], [1, 500]])))).toBeCloseTo(24000 / 1001, 6)
    expect(parseMp4FrameRate(mp4(trak("vide", 12800, [[600, 512]])))).toBe(25)
    expect(parseMp4FrameRate(mp4(trak("vide", 90000, [[100, 3003]], true)))).toBeCloseTo(30000 / 1001, 6)
  })

  it("passes over the sound track to the video one", () => {
    expect(parseMp4FrameRate(mp4(trak("soun", 48000, [[100, 1024]]), trak("vide", 24, [[100, 1]])))).toBe(24)
  })

  it("answers null for an MP4 it cannot read a rate from", () => {
    expect(parseMp4FrameRate(mp4(trak("soun", 48000, [[100, 1024]])))).toBeNull()
    expect(parseMp4FrameRate(box("ftyp", ascii("isom")))).toBeNull()
  })

  it("reads a WebM's DefaultDuration", () => {
    expect(parseWebmFrameRate(webm(41708333))).toBeCloseTo(23.976, 3)
    expect(parseWebmFrameRate(webm(40000000))).toBe(25)
    expect(parseWebmFrameRate(new Uint8Array(64))).toBeNull()
  })
})

describe("fetching it", () => {
  const ok = (body: string | Uint8Array) => ({
    ok: true,
    text: async () => body as string,
    arrayBuffer: async () => (body as Uint8Array).slice().buffer,
  }) as unknown as Response

  it("reads an HLS film from its master playlist", async () => {
    const fetchImpl = vi.fn(async () => ok(MASTER))
    expect(await fetchFilmFrameRate("https://cdn.example.test/ep101/master.m3u8?token=x", { fetchImpl })).toBe(25)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("reads an MP4 from the head of the file", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok(mp4(trak("vide", 24000, [[10, 1001]]))))
    expect(await fetchFilmFrameRate("https://cdn.example.test/clip.mp4", { fetchImpl })).toBeCloseTo(23.976, 3)
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("Range")).toBe(`bytes=0-${4 * 1024 * 1024 - 1}`)
  })

  it("looks at the tail for an MP4 whose moov comes last", async () => {
    const head = new Uint8Array(4 * 1024 * 1024)
    head.set(box("ftyp", ascii("isom")))
    head.set([0x7f, 0xff, 0xff, 0xff, ...ascii("mdat")], 12)
    const tail = new Uint8Array([9, 9, 9, ...mp4(trak("vide", 25, [[10, 1]])).slice(12)])
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      ok(new Headers(init?.headers).get("Range")!.startsWith("bytes=-") ? tail : head))
    expect(await fetchFilmFrameRate("https://cdn.example.test/film.mp4", { fetchImpl })).toBe(25)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("answers null when the film cannot be read", async () => {
    expect(await fetchFilmFrameRate("https://cdn.example.test/master.m3u8", {
      fetchImpl: vi.fn(async () => { throw new TypeError("Failed to fetch") }),
    })).toBeNull()
    expect(await fetchFilmFrameRate("https://cdn.example.test/master.m3u8", {
      fetchImpl: vi.fn(async () => ({ ok: false }) as Response),
    })).toBeNull()
  })
})
