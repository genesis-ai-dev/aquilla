import { describe, it, expect } from "vitest"
import { laneChipLabel, resolveDefaultLaneLabel, safePct } from "./project-lanes"

describe("resolveDefaultLaneLabel", () => {
  // AQU-606 regression: a migrated project keeps its target language on project
  // settings (surfaced as PortfolioProject.targetLanguage) even when the
  // per-file language hints are empty. The default ('') lane chip must show that
  // language, never the placeholder "default"/"Default".
  it("prefers the project's configured targetLanguage over the per-file hint", () => {
    expect(resolveDefaultLaneLabel({ targetLanguage: "French" }, "")).toBe("French")
    expect(resolveDefaultLaneLabel({ targetLanguage: "French" }, "German")).toBe("French")
  })

  it("shows the project target even when NO per-file hint exists (the migration case)", () => {
    expect(resolveDefaultLaneLabel({ targetLanguage: "French" }, undefined)).toBe("French")
    // …and laneChipLabel then renders the real language, not the placeholder.
    expect(laneChipLabel("", resolveDefaultLaneLabel({ targetLanguage: "French" }))).toBe("French")
  })

  it("falls back to the per-file hint when the project target is unset", () => {
    expect(resolveDefaultLaneLabel({ targetLanguage: null }, "Spanish")).toBe("Spanish")
    expect(resolveDefaultLaneLabel({}, "Spanish")).toBe("Spanish")
  })

  it("returns '' (→ generic placeholder) when neither source knows a target", () => {
    expect(resolveDefaultLaneLabel({ targetLanguage: null }, "")).toBe("")
    expect(resolveDefaultLaneLabel({ targetLanguage: "   " }, "  ")).toBe("")
    // The generic placeholder is only reached when there is genuinely no target.
    expect(laneChipLabel("", resolveDefaultLaneLabel({ targetLanguage: null }))).toBe("Default")
  })

  it("does not touch named lanes — only the '' default lane is relabeled", () => {
    expect(laneChipLabel("es", resolveDefaultLaneLabel({ targetLanguage: "French" }))).toBe("es")
  })
})

describe("safePct", () => {
  it("rounds a finite fraction to a 0..100 integer and guards NaN", () => {
    expect(safePct(0.256)).toBe(26)
    expect(safePct(Number.NaN)).toBe(0)
  })
})
