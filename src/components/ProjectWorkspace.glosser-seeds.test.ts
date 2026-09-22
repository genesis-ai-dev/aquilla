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
      { source: "word", target: "mot", weight: 5 },
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
