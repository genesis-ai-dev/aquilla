import { describe, it, expect } from "vitest"
import { deriveChecklistState } from "./useSetupChecklist"

describe("deriveChecklistState", () => {
  it("returns all incomplete when project has no settings", () => {
    const state = deriveChecklistState({}, 0, false)
    expect(state.aiProvider).toBe(false)
    expect(state.aiInstructions).toBe(false)
    expect(state.collaborators).toBe(false)
    expect(state.aiModels).toBe(false)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(4)
  })

  it("marks aiProvider complete when endpoint is set", () => {
    const state = deriveChecklistState(
      { endpoint: "https://api.frontierrnd.com/api/v1/chat/completions", model: "m", maxTokens: 512, temperature: 0.3, systemPrompt: "", llmHealthPenalty: 0.1 },
      0,
      false
    )
    expect(state.aiProvider).toBe(true)
  })

  it("marks aiInstructions complete when systemPrompt is non-empty", () => {
    const state = deriveChecklistState(
      { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "Translate carefully.", llmHealthPenalty: 0.1 },
      0,
      false
    )
    expect(state.aiInstructions).toBe(true)
  })

  it("marks collaborators complete when shareCount > 0", () => {
    const state = deriveChecklistState({}, 2, false)
    expect(state.collaborators).toBe(true)
  })

  it("marks aiModels complete when models report ready", () => {
    const state = deriveChecklistState({}, 0, true)
    expect(state.aiModels).toBe(true)
  })

  it("counts completed items correctly", () => {
    const state = deriveChecklistState(
      { endpoint: "x", model: "m", maxTokens: 512, temperature: 0.3, systemPrompt: "y", llmHealthPenalty: 0.1 },
      1,
      true
    )
    expect(state.completedCount).toBe(4)
    expect(state.totalCount).toBe(4)
  })
})
