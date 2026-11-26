// AQU-2664 (board 71): the Even out window's three scopes — the whole file,
// one track, the selected tracks — and the takes and evened takes in each.
import { describe, expect, it } from "vitest"
import { evenOutScopes, evenOutTrackStates } from "./even-out-scopes"
import type { CellData } from "@/hooks/useCells"
import type { TimelineTrack } from "@/lib/timeline/tracks"

const tr = (id: string, kind: TimelineTrack["kind"], name: string): TimelineTrack => ({ id, kind, name, order: 0 })
const TRACKS = [
  tr("source-audio", "source-audio", "Source audio"),
  tr("target-audio", "target-audio", "Jesus"),
  tr("simon", "audio", "Simon"),
  tr("narr", "audio", "Narrator"),
  tr("empty", "audio", "Matthew"),
]
const a = (slot: string, extra: Record<string, unknown> = {}) => ({ url: "u", type: "audio", slot, ...extra })
const CELLS = [
  { id: "c1", attachments: { j1: a("recording", { evenTargetLufs: -16, loudnessLufs: -20, truePeakDb: -6 }), g1: a("generatedVoice"), film: { url: "u", type: "audio", role: "source" } } },
  { id: "c2", attachments: { s1: a("simon", { evenTargetLufs: -16, loudnessLufs: -18, truePeakDb: -3 }), n1: a("narr") } },
] as unknown as CellData[]

describe("the window's scopes", () => {
  it("from the file menu: the whole file first, counting the tracks that hold takes", () => {
    const s = evenOutScopes(CELLS, TRACKS, { trackIds: [], selection: [] })
    expect(s.start).toBe("file")
    expect(s.scopes.map((x) => x.pick)).toEqual(["file"])
    expect(s.scopes[0]).toMatchObject({ trackCount: 3 })
    expect(s.scopes[0].takes).toHaveLength(4)
    expect(s.scopes[0].evened).toHaveLength(2)
  })

  it("from the file menu with one track selected: that track is the second choice", () => {
    const s = evenOutScopes(CELLS, TRACKS, { trackIds: [], selection: ["simon"] })
    expect(s.scopes.map((x) => x.pick)).toEqual(["file", "track"])
    expect(s.scopes[1]).toMatchObject({ names: ["Simon"], trackCount: 1 })
    expect(s.start).toBe("file")
  })

  it("from a track: starts on it; the main track covers both its slots", () => {
    const s = evenOutScopes(CELLS, TRACKS, { trackIds: ["target-audio"], selection: [] })
    expect(s.start).toBe("track")
    const track = s.scopes.find((x) => x.pick === "track")!
    expect(track.names).toEqual(["Jesus"])
    expect(track.takes.map((t) => t.audioId)).toEqual(["j1", "g1"])
    expect(track.evened.map((t) => t.audioId)).toEqual(["j1"])
  })

  it("the selection is a choice only while two or more tracks with takes are selected", () => {
    const one = evenOutScopes(CELLS, TRACKS, { trackIds: ["simon"], selection: ["simon", "empty"] })
    expect(one.scopes.map((x) => x.pick)).toEqual(["file", "track"])
    const three = evenOutScopes(CELLS, TRACKS, { trackIds: ["target-audio", "simon", "narr"], selection: ["target-audio", "simon", "narr"] })
    expect(three.start).toBe("sel")
    const sel = three.scopes.find((x) => x.pick === "sel")!
    expect(sel.names).toEqual(["Jesus", "Simon", "Narrator"])
    expect(sel.takes).toHaveLength(4)
    // Opened from several tracks, there is no single track to offer.
    expect(three.scopes.map((x) => x.pick)).toEqual(["file", "sel"])
  })

  // Evidence 71F: opened from one track's ⋯ (or ≈) while three are selected,
  // the window also offers that track.
  it("from a track in a selection of three: file, that track, and the selection", () => {
    const s = evenOutScopes(CELLS, TRACKS, { trackIds: ["target-audio", "simon", "narr"], selection: ["target-audio", "simon", "narr"], from: "simon" })
    expect(s.scopes.map((x) => x.pick)).toEqual(["file", "track", "sel"])
    expect(s.scopes[1].names).toEqual(["Simon"])
    expect(s.start).toBe("sel")
  })

  it("from the file menu with three selected: file, the first selected track, and the selection", () => {
    const s = evenOutScopes(CELLS, TRACKS, { trackIds: [], selection: ["target-audio", "simon", "narr"] })
    expect(s.scopes.map((x) => x.pick)).toEqual(["file", "track", "sel"])
    expect(s.start).toBe("file")
  })
})

describe("each track's ≈", () => {
  it("is in the map only for tracks that hold takes, with its state", () => {
    const m = evenOutTrackStates(CELLS, TRACKS)
    expect([...m.keys()]).toEqual(["target-audio", "simon", "narr"])
    expect(m.get("target-audio")).toBe("none")
    expect(m.get("simon")).toBe("full")
  })
})
