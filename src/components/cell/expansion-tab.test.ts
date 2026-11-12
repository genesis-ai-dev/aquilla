import { describe, expect, it } from "vitest"
import { initialExpansionTab } from "./expansion-tab"

describe("the tab an expanded cell opens on", () => {
  it("is Back-translation for an ordinary line in a language that delivers text", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: false, audioLanguage: false })).toBe("backtranslation")
  })

  // Sam, 2026-09-29 (the Audio view); AQU-1758: by the language, in every view.
  it("is Recording in a language that delivers Audio", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: false, audioLanguage: true })).toBe("audio")
  })

  it("is Recording wherever the recording does not say the text", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: true, audioLanguage: false })).toBe("audio")
  })

  // AQU-1758 (Sam): Media always opens on Recording, whatever the language.
  it("is Recording in Media, for a text language too", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: false, audioLanguage: false, media: true })).toBe("audio")
  })

  it("is Issues first in Media too", () => {
    expect(initialExpansionTab({ hasIssues: true, transcriptNeedsAttention: false, audioLanguage: false, media: true })).toBe("issues")
  })

  it("is Issues first when the line breaks a rule, in any language", () => {
    expect(initialExpansionTab({ hasIssues: true, transcriptNeedsAttention: true, audioLanguage: true })).toBe("issues")
    expect(initialExpansionTab({ hasIssues: true, transcriptNeedsAttention: false, audioLanguage: false })).toBe("issues")
  })
})
