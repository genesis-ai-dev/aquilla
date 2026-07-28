import { describe, expect, it } from "vitest"
import { deriveSpanSeeds } from "./segment"
import { pair } from "./test-helpers"

describe("deriveSpanSeeds", () => {
  it("splits scripture-style pairs on canonical_ref chapter transitions", () => {
    const pairs = [
      ...[1, 2, 3, 4, 5].map((v) => pair(`a${v}`, { canonicalRef: `MRK 1:${v}` })),
      ...[1, 2, 3].map((v) => pair(`b${v}`, { canonicalRef: `MRK 2:${v}` })),
    ]
    const seeds = deriveSpanSeeds("f1", pairs)
    expect(seeds).toHaveLength(2)
    expect(seeds[0]).toMatchObject({
      fileId: "f1",
      startCellId: "a1",
      endCellId: "a5",
      anchorCellId: "a1",
      seedSource: "canonical-ref",
    })
    expect(seeds[1]).toMatchObject({ startCellId: "b1", endCellId: "b3", seedSource: "canonical-ref" })
    expect(seeds[0].id).not.toBe(seeds[1].id)
  })

  it("keeps unref'd cells (headings) inside the current chapter run", () => {
    const pairs = [
      pair("h1"), // file intro before any ref — sticks to the first run
      pair("a1", { canonicalRef: "LUK 1:1" }),
      pair("h2"), // section heading mid-chapter
      pair("a2", { canonicalRef: "LUK 1:2" }),
      pair("b1", { canonicalRef: "LUK 2:1" }),
    ]
    const seeds = deriveSpanSeeds("f1", pairs)
    expect(seeds).toHaveLength(2)
    expect(seeds[0]).toMatchObject({ startCellId: "h1", endCellId: "a2" })
    expect(seeds[1]).toMatchObject({ startCellId: "b1", endCellId: "b1" })
  })

  it("subdivides an oversized chapter, marking continuation pieces as chunks", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => pair(`c${i + 1}`, { canonicalRef: `MRK 4:${i + 1}` }))
    const seeds = deriveSpanSeeds("f1", pairs)
    expect(seeds.length).toBeGreaterThan(1)
    for (const s of seeds) {
      const size =
        pairs.findIndex((p) => p.cellId === s.endCellId) - pairs.findIndex((p) => p.cellId === s.startCellId) + 1
      expect(size).toBeLessThanOrEqual(12)
    }
    expect(seeds[0].seedSource).toBe("canonical-ref")
    expect(seeds.slice(1).every((s) => s.seedSource === "chunk")).toBe(true)
    // Full coverage, no overlap.
    expect(seeds[0].startCellId).toBe("c1")
    expect(seeds[seeds.length - 1].endCellId).toBe("c30")
  })

  it("uses paragraph boundaries when there are no refs but paragraph starts are provided", () => {
    const pairs = Array.from({ length: 6 }, (_, i) => pair(`p${i + 1}`))
    const seeds = deriveSpanSeeds("f1", pairs, { paragraphStartCellIds: ["p3", "p5"] })
    expect(seeds.map((s) => [s.startCellId, s.endCellId])).toEqual([
      ["p1", "p2"],
      ["p3", "p4"],
      ["p5", "p6"],
    ])
    expect(seeds.every((s) => s.seedSource === "paragraph")).toBe(true)
  })

  it("falls back to fixed-size chunks (8-12 cells) for unstructured cells", () => {
    const pairs = Array.from({ length: 25 }, (_, i) => pair(`u${i + 1}`))
    const seeds = deriveSpanSeeds("f1", pairs)
    expect(seeds.every((s) => s.seedSource === "chunk")).toBe(true)
    const sizes = seeds.map(
      (s) =>
        pairs.findIndex((p) => p.cellId === s.endCellId) - pairs.findIndex((p) => p.cellId === s.startCellId) + 1,
    )
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(25)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(12)
    expect(seeds[0].startCellId).toBe("u1")
    expect(seeds[seeds.length - 1].endCellId).toBe("u25")
  })

  it("returns no seeds for an empty file", () => {
    expect(deriveSpanSeeds("f1", [])).toEqual([])
  })
})
