import { describe, expect, it } from "vitest"
import { coalesceRuns, deriveSpanSeeds, MAX_FIXED_SIZE, MIN_FIXED_SIZE } from "./segment"
import { pair } from "./test-helpers"

/** Span sizes in cell counts, in order — the property every branch must hold. */
function sizes(seeds: { startCellId: string; endCellId: string }[], pairs: { cellId: string }[]): number[] {
  return seeds.map(
    (s) =>
      pairs.findIndex((p) => p.cellId === s.endCellId) -
      pairs.findIndex((p) => p.cellId === s.startCellId) +
      1,
  )
}

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
    // Three 5-cell paragraphs: the first two merge (10 ≤ 12), the third would
    // overflow, so it starts a new span — on a real paragraph edge.
    const pairs = Array.from({ length: 15 }, (_, i) => pair(`p${i + 1}`))
    const seeds = deriveSpanSeeds("f1", pairs, { paragraphStartCellIds: ["p6", "p11"] })
    expect(seeds.map((s) => [s.startCellId, s.endCellId])).toEqual([
      ["p1", "p10"],
      ["p11", "p15"],
    ])
    expect(seeds.every((s) => s.seedSource === "paragraph")).toBe(true)
  })

  it("coalesces short paragraphs instead of making a span out of each one", () => {
    // Six 2-cell paragraphs. Un-merged this is six spans, each paying a full
    // construe → summarize → draft → verify pipeline for two sentences.
    const pairs = Array.from({ length: 12 }, (_, i) => pair(`p${i + 1}`))
    const seeds = deriveSpanSeeds("f1", pairs, {
      paragraphStartCellIds: ["p3", "p5", "p7", "p9", "p11"],
    })
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({ startCellId: "p1", endCellId: "p12", seedSource: "paragraph" })
  })

  it("never splits a paragraph across spans, and subdivides one that is too long", () => {
    const pairs = Array.from({ length: 40 }, (_, i) => pair(`p${i + 1}`))
    // p1..p4 (short), then one 36-cell paragraph.
    const seeds = deriveSpanSeeds("f1", pairs, { paragraphStartCellIds: ["p5"] })
    expect(seeds[0]).toMatchObject({ startCellId: "p1", endCellId: "p4" })
    // The oversized paragraph is subdivided; its continuation pieces are chunks.
    expect(seeds.slice(1).map((s) => s.seedSource)).toEqual(
      expect.arrayContaining(["chunk"]),
    )
    for (const size of sizes(seeds, pairs)) expect(size).toBeLessThanOrEqual(12)
    expect(seeds[seeds.length - 1].endCellId).toBe("p40")
  })

  it("paragraph spans cover the file exactly once, in order", () => {
    const pairs = Array.from({ length: 37 }, (_, i) => pair(`p${i + 1}`))
    const starts = ["p4", "p9", "p11", "p20", "p21", "p33"]
    const seeds = deriveSpanSeeds("f1", pairs, { paragraphStartCellIds: starts })
    expect(sizes(seeds, pairs).reduce((a, b) => a + b, 0)).toBe(37)
    expect(seeds[0].startCellId).toBe("p1")
    expect(seeds[seeds.length - 1].endCellId).toBe("p37")
    // Every boundary lands on a paragraph start (or the file start).
    for (const seed of seeds.slice(1)) expect(starts).toContain(seed.startCellId)
  })

  it("canonical-ref chapters are NOT coalesced — a chapter edge is a real boundary", () => {
    const pairs = [
      ...[1, 2, 3].map((v) => pair(`a${v}`, { canonicalRef: `2JN 1:${v}` })),
      ...[1, 2].map((v) => pair(`b${v}`, { canonicalRef: `2JN 2:${v}` })),
    ]
    const seeds = deriveSpanSeeds("f1", pairs)
    expect(seeds).toHaveLength(2) // 3 + 2 = 5 ≤ 12, and still not merged
  })

  it("paragraph starts are ignored when the file carries canonical refs", () => {
    const pairs = [
      ...[1, 2, 3].map((v) => pair(`a${v}`, { canonicalRef: `MRK 1:${v}` })),
      ...[1, 2].map((v) => pair(`b${v}`, { canonicalRef: `MRK 2:${v}` })),
    ]
    const seeds = deriveSpanSeeds("f1", pairs, { paragraphStartCellIds: ["a2", "b2"] })
    expect(seeds.every((s) => s.seedSource === "canonical-ref")).toBe(true)
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
    expect(deriveSpanSeeds("f1", [], { fixedSize: 5 })).toEqual([])
  })
})

describe("deriveSpanSeeds — fixedSize override", () => {
  const pairs = Array.from({ length: 25 }, (_, i) => pair(`c${i + 1}`, { canonicalRef: `MRK 4:${i + 1}` }))

  it("overrides derived structure, including canonical refs", () => {
    const seeds = deriveSpanSeeds("f1", pairs, { fixedSize: 5 })
    expect(seeds).toHaveLength(5)
    expect(sizes(seeds, pairs)).toEqual([5, 5, 5, 5, 5])
    expect(seeds.every((s) => s.seedSource === "chunk")).toBe(true)
  })

  it("leaves a short remainder as its own span rather than dropping it", () => {
    const seeds = deriveSpanSeeds("f1", pairs, { fixedSize: 10 })
    expect(sizes(seeds, pairs)).toEqual([10, 10, 5])
    expect(seeds[seeds.length - 1].endCellId).toBe("c25")
  })

  it("clamps out-of-range and fractional sizes instead of failing", () => {
    expect(sizes(deriveSpanSeeds("f1", pairs, { fixedSize: 0 }), pairs).every((n) => n <= MIN_FIXED_SIZE)).toBe(true)
    expect(deriveSpanSeeds("f1", pairs, { fixedSize: 999 })).toHaveLength(1)
    expect(MAX_FIXED_SIZE).toBeGreaterThan(MIN_FIXED_SIZE)
    expect(sizes(deriveSpanSeeds("f1", pairs, { fixedSize: 5.9 }), pairs)).toEqual([5, 5, 5, 5, 5])
  })

  it("wins over paragraph starts too", () => {
    const prose = Array.from({ length: 9 }, (_, i) => pair(`p${i + 1}`))
    const seeds = deriveSpanSeeds("f1", prose, {
      paragraphStartCellIds: ["p4", "p7"],
      fixedSize: 3,
    })
    expect(seeds.map((s) => s.seedSource)).toEqual(["chunk", "chunk", "chunk"])
  })
})

describe("coalesceRuns", () => {
  const run = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => pair(`${prefix}${i}`))

  it("merges consecutive runs up to the cap", () => {
    expect(coalesceRuns([run(2, "a"), run(3, "b"), run(4, "c")], 12).map((r) => r.length)).toEqual([9])
  })

  it("starts a new group rather than exceeding the cap", () => {
    expect(coalesceRuns([run(7, "a"), run(7, "b")], 12).map((r) => r.length)).toEqual([7, 7])
  })

  it("passes an oversized run through untouched for subdivision", () => {
    expect(coalesceRuns([run(30, "a"), run(2, "b")], 12).map((r) => r.length)).toEqual([30, 2])
  })

  it("drops empty runs and handles an empty input", () => {
    expect(coalesceRuns([], 12)).toEqual([])
    expect(coalesceRuns([[], run(3, "a"), []], 12).map((r) => r.length)).toEqual([3])
  })
})
