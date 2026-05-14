import { describe, it, expect } from "vitest"
import { deriveChecklistState } from "./useSetupChecklist"

describe("deriveChecklistState", () => {
  it("returns all incomplete when project has no settings", () => {
    const state = deriveChecklistState({}, 0, false)
    expect(state.aiInstructions).toBe(false)
    expect(state.collaborators).toBe(false)
    expect(state.aiModels).toBe(false)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(3)
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
    expect(state.completedCount).toBe(3)
    expect(state.totalCount).toBe(3)
  })
})
