import { describe, expect, it } from "vitest"
import { DEFAULT_TRACK_ID, buildTrackMetadata, deriveTracks, readTrackRef } from "./tracks"

const tagged = (id: string, label: string, kind: "subtitle" | "audio" = "subtitle") => ({
  metadata: buildTrackMetadata({ id, label, kind }),
})

/** An untagged cell: the shape every pre-AQU-904 import produced. */
const plain = (id: string) => ({ id, metadata: undefined })

describe("readTrackRef", () => {
  it("round-trips what buildTrackMetadata wrote", () => {
    expect(readTrackRef(tagged("trk_1", "audio.vtt", "audio"))).toEqual({
      id: "trk_1",
      label: "audio.vtt",
      kind: "audio",
    })
  })

  it("returns null for untagged cells", () => {
    expect(readTrackRef({})).toBeNull()
    expect(readTrackRef({ metadata: null })).toBeNull()
    expect(readTrackRef({ metadata: { paragraphStart: true } })).toBeNull()
  })

  it("returns null rather than throwing on a malformed tag", () => {
    expect(readTrackRef({ metadata: { timelineTrack: "audio.vtt" } })).toBeNull()
    expect(readTrackRef({ metadata: { timelineTrack: { label: "no id" } } })).toBeNull()
    expect(readTrackRef({ metadata: { timelineTrack: { id: "" } } })).toBeNull()
  })

  it("falls back to subtitle kind and the id as label", () => {
    expect(readTrackRef({ metadata: { timelineTrack: { id: "trk_9", kind: "bogus" } } })).toEqual({
      id: "trk_9",
      label: "trk_9",
      kind: "subtitle",
    })
  })
})

describe("deriveTracks", () => {
  it("derives exactly one default track when nothing is tagged (no regression)", () => {
    const cells = [plain("a"), plain("b")]
    const tracks = deriveTracks(cells, "Subtitles")
    expect(tracks).toHaveLength(1)
    expect(tracks[0].id).toBe(DEFAULT_TRACK_ID)
    expect(tracks[0].isDefault).toBe(true)
    expect(tracks[0].label).toBe("Subtitles")
    expect(tracks[0].cells).toEqual(cells)
  })

  it("returns no track at all for an empty lane", () => {
    expect(deriveTracks([], "Subtitles")).toEqual([])
  })

  it("keeps an imported track separate from the untagged subtitle cells", () => {
    const sub = plain("s1")
    const dub = { id: "d1", ...tagged("trk_1", "ep1-audio.vtt", "audio") }
    const tracks = deriveTracks([sub, dub], "Subtitles")
    expect(tracks.map((t) => t.id)).toEqual([DEFAULT_TRACK_ID, "trk_1"])
    expect(tracks[0].cells).toEqual([sub])
    expect(tracks[1].cells).toEqual([dub])
    expect(tracks[1].kind).toBe("audio")
    expect(tracks[1].label).toBe("ep1-audio.vtt")
  })

  it("puts the default track first even when a tagged cell comes first", () => {
    const dub = { id: "d1", ...tagged("trk_1", "audio.vtt", "audio") }
    const sub = plain("s1")
    expect(deriveTracks([dub, sub], "Subtitles").map((t) => t.id)).toEqual([DEFAULT_TRACK_ID, "trk_1"])
  })

  it("keeps several imported tracks distinct, in first-appearance order", () => {
    const a1 = { id: "a1", ...tagged("trk_a", "a.vtt", "audio") }
    const b1 = { id: "b1", ...tagged("trk_b", "b.vtt") }
    const a2 = { id: "a2", ...tagged("trk_a", "a.vtt", "audio") }
    const tracks = deriveTracks([a1, b1, a2], "Subtitles")
    expect(tracks.map((t) => t.id)).toEqual(["trk_a", "trk_b"])
    expect(tracks[0].cells).toEqual([a1, a2])
    expect(tracks[1].cells).toEqual([b1])
  })

  it("preserves the incoming (time-sorted) order within a track", () => {
    const cells = [
      { id: "c1", ...tagged("trk_a", "a.vtt") },
      { id: "c2", ...tagged("trk_a", "a.vtt") },
      { id: "c3", ...tagged("trk_a", "a.vtt") },
    ]
    expect(deriveTracks(cells, "Subtitles")[0].cells.map((c) => c.id)).toEqual(["c1", "c2", "c3"])
  })
})
