/**
 * AQU-207 — the interlinear confirm/invalidate loop must reach the statistical BT.
 *
 * The panel, its persistence, and interlinear.ts's own model were already wired:
 * confirming an alignment persisted an `AlignmentSeed` on the project and fed it
 * back into `buildAlignmentModel`, so the panel's *suggestions* sharpened. But
 * ProjectWorkspace assembled the glosser's seeds from corrected BTs and the
 * termbase only, so the back-translation the user actually reads never moved —
 * acceptance criterion "a confirmed alignment measurably influences subsequent
 * statistical BT output" was unmet.
 *
 * That assembly is the level the regression escaped at, so it is tested here,
 * directly — the same extract-the-helper pattern as `shouldApplyCheckResult`,
 * since rendering the full ProjectWorkspace isn't needed to prove the logic.
 */
import { describe, it, expect } from "vitest"
import { buildGlosserSeeds } from "./project-workspace-helpers"
import { buildGlosser, ALIGNMENT_SEED_BT_WEIGHT } from "@/lib/completion/bt-glosser"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import type { BacktranslationRecord } from "@/lib/completion/bt-record"
import type { GlossRecord } from "@/lib/completion/gloss-record"
import type { ProjectRecord } from "@/lib/parsers/types"

const NO_CELLS: readonly CellSummary[] = []
const NO_BT = new Map<string, BacktranslationRecord>()

function seedsFor(alignmentSeeds: ProjectRecord["alignmentSeeds"]) {
  return buildGlosserSeeds({
    corpusCells: NO_CELLS,
    backtranslationCache: NO_BT,
    terminology: undefined,
    alignmentSeeds,
  })
}

describe("buildGlosserSeeds — alignment seeds reach the glosser (AQU-207)", () => {
  it("includes a confirmed alignment as a positive glosser seed", () => {
    expect(seedsFor([{ srcToken: "scripture", tgtToken: "mot", weight: 1 }])).toEqual([
      { source: "scripture", target: "mot", weight: ALIGNMENT_SEED_BT_WEIGHT },
    ])
  })

  it("includes an invalidated alignment as a negative glosser seed", () => {
    expect(seedsFor([{ srcToken: "word", tgtToken: "mot", weight: -1 }])).toEqual([
      { source: "word", target: "mot", weight: -ALIGNMENT_SEED_BT_WEIGHT },
    ])
  })

  it("contributes nothing when the project has no alignment seeds", () => {
    expect(seedsFor(undefined)).toEqual([])
    expect(seedsFor([])).toEqual([])
  })

  it("keeps the corrected-BT and termbase seeds it already carried", () => {
    const cell = {
      id: "c1",
      translated: "mot",
      targetEventId: "e1",
    } as unknown as CellSummary
    const btCache = new Map<string, BacktranslationRecord>([
      [
        "c1",
        { cellId: "c1", btText: "word", forText: "mot", targetEventId: "e1", polished: false } as
          BacktranslationRecord,
      ],
    ])
    const terminology = [
      {
        status: "active",
        sourceTerm: "covenant",
        renderings: [{ status: "preferred", rendering: "alliance" }],
      },
    ] as unknown as ProjectRecord["terminology"]

    const seeds = buildGlosserSeeds({
      corpusCells: [cell],
      backtranslationCache: btCache,
      terminology,
      alignmentSeeds: [{ srcToken: "scripture", tgtToken: "mot", weight: 1 }],
    })

    expect(seeds).toEqual([
      { source: "word", target: "mot", weight: 5, originId: "c1" },
      { source: "covenant", target: "alliance", weight: 3 },
      { source: "scripture", target: "mot", weight: ALIGNMENT_SEED_BT_WEIGHT },
    ])
  })

  it("drops a corrected BT pinned to a superseded target event", () => {
    const cell = { id: "c1", translated: "mot", targetEventId: "e2" } as unknown as CellSummary
    const btCache = new Map<string, BacktranslationRecord>([
      [
        "c1",
        { cellId: "c1", btText: "word", forText: "mot", targetEventId: "e1", polished: false } as
          BacktranslationRecord,
      ],
    ])
    expect(
      buildGlosserSeeds({
        corpusCells: [cell],
        backtranslationCache: btCache,
        terminology: undefined,
        alignmentSeeds: undefined,
      }),
    ).toEqual([])
  })
})

describe("the assembled seeds measurably change BT output (AQU-207)", () => {
  // The end-to-end claim in the acceptance criteria: a confirmation the user
  // makes in the panel changes the gloss they read afterwards.
  const pairs = [{ source: "word", target: "mot" }]

  it("a confirmation flips the gloss for that target token", () => {
    expect(buildGlosser(pairs, seedsFor(undefined)).gloss("mot")).toBe("word")
    expect(
      buildGlosser(pairs, seedsFor([{ srcToken: "scripture", tgtToken: "mot", weight: 1 }])).gloss(
        "mot",
      ),
    ).toBe("scripture")
  })

  it("an invalidation demotes the rejected rendering below the runner-up", () => {
    const competing = [
      { source: "word", target: "mot" },
      { source: "word", target: "mot" },
      { source: "term", target: "mot" },
    ]
    expect(buildGlosser(competing, seedsFor(undefined)).gloss("mot")).toBe("word")
    expect(
      buildGlosser(competing, seedsFor([{ srcToken: "word", tgtToken: "mot", weight: -1 }])).gloss(
        "mot",
      ),
    ).toBe("term")
  })
})

/**
 * AQU-1408 §2 — a corrected statistical gloss is training data.
 *
 * Josseline (Biblica ETT) asked for the editable gloss because it "only draws
 * from validated text and is wrong until more books are validated". Making it
 * editable without feeding it back would fix one cell at a time; the point is
 * that correcting a word here fixes it everywhere that word appears. That
 * feedback happens in exactly one place — this seed assembly — so it is tested
 * here, with the glosser built from the result to prove the correction lands.
 */
describe("buildGlosserSeeds — corrected glosses re-seed the glosser (AQU-1408 §2)", () => {
  const corpus = [
    { id: "c1", translated: "maison", targetEventId: "e1" },
    { id: "c2", translated: "maison grande", targetEventId: "e2" },
  ] as unknown as CellSummary[]

  function glossCacheOf(over: Partial<GlossRecord> = {}) {
    return new Map<string, GlossRecord>([
      ["c1", {
        cellId: "c1",
        glossText: "dwelling",
        forText: "maison",
        targetEventId: "e1",
        createdAt: 1,
        ...over,
      }],
    ])
  }

  function seeds(glossCache: ReadonlyMap<string, GlossRecord> | undefined) {
    return buildGlosserSeeds({
      corpusCells: corpus,
      backtranslationCache: NO_BT,
      glossCache,
      terminology: undefined,
      alignmentSeeds: undefined,
    })
  }

  it("seeds a corrected gloss at the hand-edited weight, tagged with its cell", () => {
    expect(seeds(glossCacheOf())).toEqual([
      { source: "dwelling", target: "maison", weight: 5, originId: "c1" },
    ])
  })

  it("contributes nothing when no gloss has been corrected", () => {
    expect(seeds(undefined)).toEqual([])
    expect(seeds(new Map())).toEqual([])
  })

  it("ignores a withdrawn correction", () => {
    expect(seeds(glossCacheOf({ glossText: "   " }))).toEqual([])
  })

  it("ignores a correction pinned to a superseded commit", () => {
    expect(seeds(glossCacheOf({ targetEventId: "stale" }))).toEqual([])
  })

  // The acceptance criterion in its own words: after an edited gloss is saved,
  // glosses for OTHER cells with the same words reflect the correction.
  it("moves the gloss of a different cell that shares the corrected words", () => {
    const pairs = [
      { source: "house", target: "maison", id: "c1" },
      { source: "house big", target: "maison grande", id: "c2" },
    ]
    const glossC2 = (cache: ReadonlyMap<string, GlossRecord> | undefined) =>
      buildGlosser(pairs, seeds(cache)).gloss("maison grande", { excludeId: "c2" })

    expect(glossC2(undefined)).toContain("house")
    expect(glossC2(glossCacheOf())).toContain("dwelling")
  })

  // Leave-one-out: without originId the corrected cell's own gloss would just
  // replay the correction out of the model instead of being excluded, which is
  // how a seeded corpus silently stops being a check on itself.
  it("tags the seed so the corrected cell's own leave-one-out gloss excludes it", () => {
    expect(seeds(glossCacheOf())[0].originId).toBe("c1")
  })
})
