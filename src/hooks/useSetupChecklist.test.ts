import { describe, it, expect, beforeEach } from "vitest"
import { deriveChecklistState, wasSetupAutoShown, markSetupAutoShown } from "./useSetupChecklist"

describe("deriveChecklistState", () => {
  it("returns all incomplete when project has no settings", () => {
    const state = deriveChecklistState({}, 0, false, 0)
    expect(state.importFiles).toBe(false)
    expect(state.aiInstructions).toBe(false)
    expect(state.collaborators).toBe(false)
    expect(state.aiModels).toBe(false)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(4)
  })

  // AQU-302: import files is the first step and completes when fileCount > 0
  it("AQU-302: marks importFiles complete when fileCount > 0", () => {
    const state = deriveChecklistState({}, 0, false, 1)
    expect(state.importFiles).toBe(true)
  })

  it("AQU-302: importFiles is false when fileCount is 0", () => {
    const state = deriveChecklistState({}, 0, false, 0)
    expect(state.importFiles).toBe(false)
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
      true,
      3
    )
    expect(state.completedCount).toBe(4)
    expect(state.totalCount).toBe(4)
  })

  // AQU-234: saving instructions must mark the step complete. The systemPrompt
  // must be non-empty for aiInstructions to flip — empty string means unsaved.
  it("AQU-234: aiInstructions requires a non-empty, non-whitespace systemPrompt", () => {
    expect(deriveChecklistState({ systemPrompt: "" }, 0, false).aiInstructions).toBe(false)
    expect(deriveChecklistState({ systemPrompt: "   " }, 0, false).aiInstructions).toBe(false)
    expect(deriveChecklistState({ systemPrompt: "Translate carefully." }, 0, false).aiInstructions).toBe(true)
  })
})

describe("wasSetupAutoShown / markSetupAutoShown", () => {
  // AQU-244: localStorage helpers for auto-surface shown-once tracking.
  beforeEach(() => {
    // Clear only the keys this test group uses so other tests are unaffected.
    localStorage.removeItem("codex.setupAutoShown.p-unit-1")
    localStorage.removeItem("codex.setupAutoShown.p-unit-2")
  })

  it("AQU-244: returns false before first mark, true after", () => {
    expect(wasSetupAutoShown("p-unit-1")).toBe(false)
    markSetupAutoShown("p-unit-1")
    expect(wasSetupAutoShown("p-unit-1")).toBe(true)
  })

  it("AQU-244: different projects have independent shown flags", () => {
    markSetupAutoShown("p-unit-1")
    expect(wasSetupAutoShown("p-unit-2")).toBe(false)
  })

  // AQU-244: the shouldAutoOpen guard reads wasSetupAutoShown() directly at
  // render time — NOT via mirrored state — so project A→B switches don't
  // inherit A's stale flag. Verify the raw helpers compose correctly for the
  // scenario the panel described:
  //   - Switch to already-shown project → wasSetupAutoShown returns true →
  //     shouldAutoOpen would be false → no pop, flag NOT burned.
  it("AQU-244: already-shown project returns true immediately (no state lag)", () => {
    markSetupAutoShown("p-unit-1")
    // Simulates switching back to the same project: reading at render time
    // returns true immediately, no React state update cycle needed.
    expect(wasSetupAutoShown("p-unit-1")).toBe(true)
  })

  it("AQU-244: unshown project returns false even after another project is marked", () => {
    markSetupAutoShown("p-unit-1")
    // B was never shown — switching A→B should NOT inherit A's flag.
    expect(wasSetupAutoShown("p-unit-2")).toBe(false)
  })
})
