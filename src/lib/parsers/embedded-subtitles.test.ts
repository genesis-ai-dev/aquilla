import { describe, expect, it } from "vitest"
import { extractEmbeddedSubtitles } from "./embedded-subtitles"

import { embeddedSubtitleFixture as fixture } from "./__fixtures__/embedded-subtitles"

const utf8 = (text: string) => new TextEncoder().encode(text)

describe("extractEmbeddedSubtitles", () => {
  it("reads timed wording from an M4A tx3g track", () => {
    const tracks = extractEmbeddedSubtitles(fixture())
    expect(tracks).toHaveLength(1)
    expect(tracks[0].codec).toBe("tx3g")
    expect(tracks[0].cues).toEqual([
      { text: "First phrase", start: 0, end: 1 },
      { text: "Second phrase", start: 1, end: 3 },
    ])
  })

  it("decodes UTF-16 wording in both byte orders", () => {
    // tx3g permits UTF-16 text identified by a byte-order mark.
    const bigEndian = new Uint8Array([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d])
    const littleEndian = new Uint8Array([0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde])
    expect(extractEmbeddedSubtitles(fixture([bigEndian, littleEndian]))[0].cues).toEqual([
      { text: "你好", start: 0, end: 1 },
      { text: "😀", start: 1, end: 3 },
    ])
  })

  it("places subtitle timings on the movie timeline after an empty edit", () => {
    expect(extractEmbeddedSubtitles(fixture(undefined, { edit: true }))[0].cues).toEqual([
      { text: "First phrase", start: 0.5, end: 1.5 },
      { text: "Second phrase", start: 1.5, end: 3.5 },
    ])
  })

  it("rejects subtitle samples pointing outside media data", () => {
    const bytes = new Uint8Array(fixture())
    bytes.set(utf8("free"), 4)
    expect(extractEmbeddedSubtitles(bytes.buffer)).toEqual([])
  })

  it.each([{ offsets64: true }, { splitChunks: true }])(
    "reads the same wording with alternate chunk offsets %j",
    options => {
      expect(extractEmbeddedSubtitles(fixture(undefined, options)))
        .toEqual(extractEmbeddedSubtitles(fixture()))
    },
  )

  it("ignores empty text samples without shifting the next cue", () => {
    expect(extractEmbeddedSubtitles(fixture(["", "Speech"]))[0].cues)
      .toEqual([{ text: "Speech", start: 1, end: 3 }])
  })

  it("locates subtitle samples after many separate media-data boxes", () => {
    expect(extractEmbeddedSubtitles(fixture(undefined, {
      leadingEmptyMediaBoxes: 5_000,
      splitChunks: true,
    }))).toEqual(extractEmbeddedSubtitles(fixture()))
  })

  it("treats truncated containers as unavailable subtitles", () => {
    const valid = fixture()
    expect(extractEmbeddedSubtitles(valid.slice(0, valid.byteLength - 1)))
      .toEqual([])
    expect(extractEmbeddedSubtitles(new ArrayBuffer(0))).toEqual([])
  })

  it("rejects excessive container metadata before offering subtitle tracks", () => {
    const valid = new Uint8Array(fixture())
    const metadata = new Uint8Array(100_001 * 8)
    const view = new DataView(metadata.buffer)
    for (let offset = 0; offset < metadata.length; offset += 8) {
      view.setUint32(offset, 8)
      metadata.set(utf8("free"), offset + 4)
    }
    const bytes = new Uint8Array(valid.length + metadata.length)
    bytes.set(valid)
    bytes.set(metadata, valid.length)
    expect(extractEmbeddedSubtitles(bytes.buffer)).toEqual([])
  })
})
