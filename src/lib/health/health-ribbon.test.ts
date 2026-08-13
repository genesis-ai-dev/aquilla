import { describe, expect, it } from "vitest"
import {
  buildHealthRibbon,
  healthRibbonColor,
  preTranslationEvidence,
} from "./health-ribbon"

describe("buildHealthRibbon", () => {
  it("uses a symmetric EMA so document direction does not bias the trend", () => {
    const points = buildHealthRibbon([
      { id: "a", scope: "chapter", stage: "automatic", rawScore: 20 },
      { id: "b", scope: "chapter", stage: "automatic", rawScore: 80 },
    ], 0.5)

    expect(points.get("a")?.smoothedScore).toBeCloseTo(40)
    expect(points.get("b")?.smoothedScore).toBeCloseTo(60)
    expect(points.get("a")?.bottomScore).toBeCloseTo(50)
    expect(points.get("b")?.topScore).toBeCloseTo(50)
  })

  it("does not let validated 100s inflate automatic neighbors", () => {
    const points = buildHealthRibbon([
      { id: "a", scope: "chapter", stage: "automatic", rawScore: 20 },
      { id: "v", scope: "chapter", stage: "validated", rawScore: 5 },
      { id: "b", scope: "chapter", stage: "automatic", rawScore: 80 },
    ])

    expect(points.get("a")?.smoothedScore).toBe(20)
    expect(points.get("v")?.rawScore).toBe(100)
    expect(points.get("v")?.smoothedScore).toBe(100)
    expect(points.get("b")?.smoothedScore).toBe(80)
    // Only the rendered edge blends, so color/opacity meet continuously while
    // the automatic scores above remain untouched.
    expect(points.get("a")?.bottomScore).toBe(60)
    expect(points.get("a")?.bottomOpacity).toBeCloseTo(0.69)
    expect(points.get("v")?.topScore).toBe(60)
    expect(points.get("v")?.topOpacity).toBeCloseTo(0.69)
    expect(points.get("v")?.bottomScore).toBe(90)
    expect(points.get("b")?.topScore).toBe(90)
    expect(points.get("b")?.topOpacity).toBeCloseTo(0.69)
  })

  it("resets at scope boundaries and preserves missing evidence as unknown", () => {
    const points = buildHealthRibbon([
      { id: "a", scope: "chapter-1", stage: "automatic", rawScore: 20 },
      { id: "unknown", scope: "chapter-1", stage: "automatic" },
      { id: "b", scope: "chapter-2", stage: "automatic", rawScore: 80 },
    ])

    expect(points.get("a")?.smoothedScore).toBe(20)
    expect(points.get("unknown")?.smoothedScore).toBeUndefined()
    expect(points.get("b")?.smoothedScore).toBe(80)
  })
})

describe("preTranslationEvidence", () => {
  it("reports source coverage and evidence weight without claiming target quality", () => {
    const evidence = preTranslationEvidence("the quick fox", [
      { matchedTokens: ["quick", "fox"] },
    ])

    expect(evidence?.score).toBeCloseTo(66.67, 1)
    expect(evidence?.evidenceWeight).toBe(0.2)
    expect(preTranslationEvidence("the quick fox", [])).toBeNull()
  })
})

describe("healthRibbonColor", () => {
  it("forms a continuous red to amber to green scale", () => {
    expect(healthRibbonColor(0)).toBe("rgb(239 68 68)")
    expect(healthRibbonColor(50)).toBe("rgb(245 158 11)")
    expect(healthRibbonColor(100)).toBe("rgb(34 197 94)")
    expect(healthRibbonColor(50, 0.4)).toBe("rgb(245 158 11 / 0.4)")
  })
})
