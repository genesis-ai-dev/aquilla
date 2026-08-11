// WHY these tests exist: the band is the one thing on screen that claims to
// describe the whole soundtrack, so "contiguous, ordered, no holes, no
// overlaps, covering exactly [0, totalSec]" is a promise rather than an
// implementation detail — a hole here reads as a piece of the episode that does
// not exist. The silent stretches are pinned explicitly because they are the
// entire point of the feature, and the overlap case is pinned because real VTTs
// contain it and the obvious pairwise implementation quietly loses a timestamp.

import { describe, expect, it } from "vitest"
import {
  deriveSourceRegions,
  findRegionAt,
  regionAfterCell,
  regionBeforeCell,
  cellIdAtSec,
  type RegionSegment,
} from "./source-regions"

const seg = (id: string, startTime: number, endTime: number): RegionSegment => ({ id, startTime, endTime })

/** The invariant every case has to satisfy. */
function expectContiguous(map: ReturnType<typeof deriveSourceRegions>) {
  let at = 0
  for (const r of map.regions) {
    expect(r.startSec).toBeCloseTo(at, 6)
    expect(r.endSec).toBeGreaterThan(r.startSec)
    at = r.endSec
  }
  expect(at).toBeCloseTo(map.totalSec, 6)
}

describe("deriveSourceRegions", () => {
  it("draws the silence before the first cue, between cues, and after the last", () => {
    const map = deriveSourceRegions([seg("a", 10, 12), seg("b", 20, 22)], 30)
    expect(map.regions.map((r) => [r.startSec, r.endSec, r.kind])).toEqual([
      [0, 10, "gap"],
      [10, 12, "cue"],
      [12, 20, "gap"],
      [20, 22, "cue"],
      [22, 30, "gap"],
    ])
    expectContiguous(map)
  })

  it("names the owning cell on a cue stretch and nobody on a gap", () => {
    const map = deriveSourceRegions([seg("a", 1, 2)], 4)
    expect(map.regions[0].cellIds).toEqual([])
    expect(map.regions[1].cellIds).toEqual(["a"])
    expect(map.regions[2].cellIds).toEqual([])
  })

  it("two cues that touch exactly are a division, NOT an overlap", () => {
    const map = deriveSourceRegions([seg("a", 0, 5), seg("b", 5, 10)], 10)
    expect(map.regions.map((r) => r.kind)).toEqual(["cue", "cue"])
    expect(map.regions.map((r) => r.cellIds)).toEqual([["a"], ["b"]])
    expectContiguous(map)
  })

  it("two speakers at once become one stretch owned by both", () => {
    // Real subtitle files do this. A pairwise walk would have to clip or drop
    // one of them, moving a timestamp the user can see in their own file.
    const map = deriveSourceRegions([seg("a", 0, 6), seg("b", 4, 10)], 10)
    expect(map.regions.map((r) => [r.startSec, r.endSec, r.kind])).toEqual([
      [0, 4, "cue"],
      [4, 6, "overlap"],
      [6, 10, "cue"],
    ])
    expect(map.regions[1].cellIds.slice().sort()).toEqual(["a", "b"])
    expectContiguous(map)
  })

  it("a cue wholly inside another is still an overlap, and the outer one resumes", () => {
    const map = deriveSourceRegions([seg("outer", 0, 10), seg("inner", 3, 5)], 10)
    expect(map.regions.map((r) => r.kind)).toEqual(["cue", "overlap", "cue"])
    expect(map.regions[2].cellIds).toEqual(["outer"])
    expectContiguous(map)
  })

  it("with no cues at all the whole video is one silence", () => {
    const map = deriveSourceRegions([], 90)
    expect(map.regions).toHaveLength(1)
    expect(map.regions[0]).toMatchObject({ startSec: 0, endSec: 90, kind: "gap" })
  })

  it("without a known duration it spans the cues, which is what the row showed before", () => {
    const map = deriveSourceRegions([seg("a", 1, 2)], null)
    expect(map.totalSec).toBe(2)
    expectContiguous(map)
  })

  it("a cue running past the end of the video still fits — nothing is clipped away", () => {
    const map = deriveSourceRegions([seg("a", 5, 200)], 100)
    expect(map.totalSec).toBe(200)
    expectContiguous(map)
  })

  it("ignores untimed, zero-length and inverted cues", () => {
    const map = deriveSourceRegions(
      [
        { id: "untimed" },
        { id: "half", startTime: 3 },
        seg("zero", 4, 4),
        seg("inverted", 9, 7),
        seg("real", 1, 2),
      ],
      6,
    )
    expect(map.regions.filter((r) => r.kind !== "gap").map((r) => r.cellIds)).toEqual([["real"]])
    expectContiguous(map)
  })

  it("is empty when there is neither footage nor timing", () => {
    expect(deriveSourceRegions([], null).regions).toHaveLength(0)
    expect(deriveSourceRegions([{ id: "x" }], 0).totalSec).toBe(0)
  })

  it("does not mutate its input", () => {
    const input = [seg("b", 20, 22), seg("a", 10, 12)]
    const snapshot = JSON.parse(JSON.stringify(input))
    deriveSourceRegions(input, 30)
    expect(input).toEqual(snapshot)
  })

  it("holds up on the real demo file's shape", () => {
    // The Chosen S3E2: first cue at 41.792s, last ending at 4029.321s, video
    // 4212.096s — a 41.8s head and a 182.8s tail, both silent.
    const map = deriveSourceRegions([seg("first", 41.792, 43.043), seg("last", 4020, 4029.321)], 4212.096)
    expect(map.regions[0]).toMatchObject({ startSec: 0, endSec: 41.792, kind: "gap" })
    const tail = map.regions[map.regions.length - 1]
    expect(tail.kind).toBe("gap")
    expect(tail.endSec - tail.startSec).toBeCloseTo(182.775, 3)
    expectContiguous(map)
  })
})

describe("findRegionAt", () => {
  const map = deriveSourceRegions([seg("a", 10, 12)], 30)

  it("finds the stretch a second falls in, and treats a boundary as the start of the next", () => {
    expect(findRegionAt(map, 5)?.kind).toBe("gap")
    expect(findRegionAt(map, 10)?.cellIds).toEqual(["a"])
    expect(findRegionAt(map, 11.999)?.cellIds).toEqual(["a"])
    expect(findRegionAt(map, 12)?.kind).toBe("gap")
  })

  it("returns the last stretch exactly at the end, and null outside", () => {
    expect(findRegionAt(map, 30)?.endSec).toBe(30)
    expect(findRegionAt(map, 30.001)).toBeNull()
    expect(findRegionAt(map, -1)).toBeNull()
    expect(findRegionAt(map, NaN)).toBeNull()
  })
})

describe("regionAfterCell / regionBeforeCell", () => {
  const map = deriveSourceRegions([seg("a", 10, 12), seg("b", 20, 22)], 30)

  it("gives the silence a new line would claim on either side", () => {
    expect(regionAfterCell(map, "a")).toMatchObject({ startSec: 12, endSec: 20, kind: "gap" })
    expect(regionBeforeCell(map, "b")).toMatchObject({ startSec: 12, endSec: 20, kind: "gap" })
    expect(regionBeforeCell(map, "a")).toMatchObject({ startSec: 0, endSec: 10, kind: "gap" })
  })

  it("gives the trailing silence after the last cue", () => {
    expect(regionAfterCell(map, "b")).toMatchObject({ startSec: 22, endSec: 30, kind: "gap" })
  })

  it("steps past an overlap to the stretch beyond it", () => {
    const overlapped = deriveSourceRegions([seg("a", 0, 6), seg("b", 4, 10)], 20)
    // "a" owns [0,4] and [4,6]; after it is where "b" alone continues.
    expect(regionAfterCell(overlapped, "a")).toMatchObject({ startSec: 6, endSec: 10, cellIds: ["b"] })
  })

  it("is null for a cell that is not on the band, and at the very ends", () => {
    expect(regionAfterCell(map, "nope")).toBeNull()
    expect(regionBeforeCell(map, "nope")).toBeNull()
    const flush = deriveSourceRegions([seg("only", 0, 10)], 10)
    expect(regionBeforeCell(flush, "only")).toBeNull()
    expect(regionAfterCell(flush, "only")).toBeNull()
  })
})

// The burned-in caption needs this when the linked VIDEO is the transport: the
// play queue answers "what is sounding" everywhere it runs, and it cannot run
// at all for a subtitle file with no audio, so there is nothing to ask.
describe("cellIdAtSec", () => {
  const subs = [seg("a", 10, 12), seg("b", 20, 22)]

  it("finds the line covering a second", () => {
    expect(cellIdAtSec(subs, 11)).toBe("a")
    expect(cellIdAtSec(subs, 21.5)).toBe("b")
  })

  it("is null in the silences — the caption clears between lines", () => {
    expect(cellIdAtSec(subs, 0)).toBeNull()
    expect(cellIdAtSec(subs, 15)).toBeNull()
    expect(cellIdAtSec(subs, 99)).toBeNull()
  })

  it("is half-open, so a cue ending where the next starts hands over cleanly", () => {
    const touching = [seg("a", 0, 5), seg("b", 5, 10)]
    expect(cellIdAtSec(touching, 5)).toBe("b")
    expect(cellIdAtSec(touching, 4.999)).toBe("a")
  })

  it("includes the first frame of a line and excludes the last", () => {
    expect(cellIdAtSec(subs, 10)).toBe("a")
    expect(cellIdAtSec(subs, 12)).toBeNull()
  })

  it("burns one line when two overlap — a single caption slot cannot say more", () => {
    expect(cellIdAtSec([seg("a", 0, 6), seg("b", 4, 10)], 5)).toBe("a")
  })

  it("ignores untimed cells and rubbish input", () => {
    expect(cellIdAtSec([{ id: "untimed" }, seg("a", 1, 2)], 1.5)).toBe("a")
    expect(cellIdAtSec(subs, NaN)).toBeNull()
    expect(cellIdAtSec([], 5)).toBeNull()
  })
})
