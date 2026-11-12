import { describe, it, expect } from "vitest"
import { projectTranslationInstructions } from "./project-instructions"

// AQU-2342: the record carries the settings GET's legacy agent brief, so the
// copilot resolves from exactly the sources the server paths read.
describe("projectTranslationInstructions", () => {
  it("uses the record's legacy agent brief and the legacy device prompt; stored text wins over both", () => {
    expect(projectTranslationInstructions({ legacyProjectBriefText: "Keep divine names." })).toBe("Keep divine names.")
    expect(projectTranslationInstructions({
      legacyProjectBriefText: "Keep divine names.",
      completionSettings: { systemPrompt: "Use plain words." } as never,
    })).toBe("Use plain words.\n\nKeep divine names.")
    expect(projectTranslationInstructions({ translationInstructions: "Ours.", legacyProjectBriefText: "Keep divine names." }))
      .toBe("Ours.")
    expect(projectTranslationInstructions(null)).toBe("")
  })
})
