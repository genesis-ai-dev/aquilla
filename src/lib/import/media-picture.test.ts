import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { importedMediaType, mediaHasPicture } from "./media-picture"

// ── Tiny containers, built byte by byte ─────────────────────────────────────

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let at = 8
  for (const p of payload) { out.set(p, at); at += p.length }
  return out
}
const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const zeros = (n: number) => new Uint8Array(n)
/** hdlr: version+flags, pre_defined, handler type, reserved, name. */
const hdlr = (handler: string) => box("hdlr", zeros(4), zeros(4), text(handler), zeros(12), text("x\0"))
const trak = (handler: string) => box("trak", box("mdia", hdlr(handler)))
function mp4(handlers: string[], moovFirst = true): Blob {
  const ftyp = box("ftyp", text("isom"), zeros(4), text("isomiso2"))
  const mdat = box("mdat", zeros(64))
  const moov = box("moov", box("mvhd", zeros(100)), ...handlers.map(trak))
  return new Blob(moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov])
}

/** EBML element with a one-byte size (payloads here stay under 127 bytes). */
function el(id: number[], ...payload: Uint8Array[]): Uint8Array {
  const size = payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(id.length + 1 + size)
  out.set(id, 0)
  out[id.length] = 0x80 | size
  let at = id.length + 1
  for (const p of payload) { out.set(p, at); at += p.length }
  return out
}
function webm(trackTypes: number[], segmentSizeUnknown = true): Blob {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], text("webm")))
  const tracks = el([0x16, 0x54, 0xae, 0x6b],
    ...trackTypes.map((type, i) => el([0xae], el([0xd7], Uint8Array.of(i + 1)), el([0x83], Uint8Array.of(type)))))
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40)))
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], Uint8Array.of(0)))
  const body = [info, tracks, cluster]
  const bodySize = body.reduce((n, p) => n + p.length, 0)
  const segmentHead = segmentSizeUnknown
    ? Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
    : Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0x40 | (bodySize >> 8), bodySize & 0xff)
  return new Blob([header, segmentHead, ...body])
}

describe("mediaHasPicture", () => {
  it("reads an MP4's tracks: a picture track, or sound only", async () => {
    expect(await mediaHasPicture(mp4(["vide", "soun"]))).toBe(true)
    expect(await mediaHasPicture(mp4(["soun"]))).toBe(false)
  })

  it("finds the tracks of an MP4 whose moov comes after its media", async () => {
    expect(await mediaHasPicture(mp4(["soun", "vide"], false))).toBe(true)
    expect(await mediaHasPicture(mp4(["soun"], false))).toBe(false)
  })

  it("reads a WebM's tracks, with the segment's size known or not", async () => {
    expect(await mediaHasPicture(webm([1, 2]))).toBe(true)
    expect(await mediaHasPicture(webm([2]))).toBe(false)
    expect(await mediaHasPicture(webm([2], false))).toBe(false)
  })

  it("is unsure about anything it can't read", async () => {
    expect(await mediaHasPicture(new Blob([text("RIFF....WAVEfmt ")]))).toBeUndefined()
    expect(await mediaHasPicture(new Blob([zeros(4)]))).toBeUndefined()
  })

  it("reads the app's own test films", async () => {
    const fixture = (name: string) =>
      new Blob([readFileSync(join(__dirname, "..", "..", "..", "e2e", "fixtures", name))])
    expect(await mediaHasPicture(fixture("tone-picture.mp4"))).toBe(true)
    expect(await mediaHasPicture(fixture("embedded-captions.mp4"))).toBe(true)
  })
})

describe("importedMediaType", () => {
  it("brings a sound-only .webm or .mp4 in as audio", async () => {
    expect(await importedMediaType(webm([2]), "video")).toBe("audio")
    expect(await importedMediaType(mp4(["soun"]), "video")).toBe("audio")
  })

  it("keeps a film a film, and keeps the name's type when unsure", async () => {
    expect(await importedMediaType(webm([1, 2]), "video")).toBe("video")
    expect(await importedMediaType(new Blob([zeros(64)]), "video")).toBe("video")
    expect(await importedMediaType(new Blob([zeros(64)]), "audio")).toBe("audio")
  })
})
