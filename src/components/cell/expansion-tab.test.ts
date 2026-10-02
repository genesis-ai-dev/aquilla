import { describe, expect, it } from "vitest"
import { initialExpansionTab } from "./expansion-tab"

describe("the tab an expanded cell opens on", () => {
  it("is Back-translation for an ordinary line in the Text view", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: false, audioView: false })).toBe("backtranslation")
  })

  // Sam, 2026-09-29.
  it("is Recording in the Audio view", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: false, audioView: true })).toBe("audio")
  })

  it("is Recording wherever the recording does not say the text", () => {
    expect(initialExpansionTab({ hasIssues: false, transcriptNeedsAttention: true, audioView: false })).toBe("audio")
  })

  it("is Issues first when the line breaks a rule, in either view", () => {
    expect(initialExpansionTab({ hasIssues: true, transcriptNeedsAttention: true, audioView: true })).toBe("issues")
    expect(initialExpansionTab({ hasIssues: true, transcriptNeedsAttention: false, audioView: false })).toBe("issues")
  })
})
