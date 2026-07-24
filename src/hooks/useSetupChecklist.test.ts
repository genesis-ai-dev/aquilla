import { describe, it, expect, beforeEach } from "vitest"
import {
  deriveChecklistState,
  isSetupInProgress,
  markSetupInProgress,
  clearSetupInProgress,
} from "./useSetupChecklist"

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

  // AQU-701: an explicit "we don't use voice/transcription" skip counts the
  // voice & transcription step as handled so the checklist stops nagging.
  it("AQU-701: marks aiModels complete when the step is skipped, even if models aren't ready", () => {
    const state = deriveChecklistState({}, 0, false, 0, true)
    expect(state.aiModels).toBe(true)
    expect(state.totalCount).toBe(4)
    expect(state.completedCount).toBe(1)
  })

  it("AQU-701: leaves aiModels incomplete when neither ready nor skipped", () => {
    expect(deriveChecklistState({}, 0, false, 0, false).aiModels).toBe(false)
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

describe("isSetupInProgress / markSetupInProgress / clearSetupInProgress", () => {
  // AQU-694: per-project localStorage helpers that record the user is mid-setup
  // so a browser refresh can restore the drawer — WITHOUT ever auto-opening a
  // checklist the user never engaged with.
  beforeEach(() => {
    // Clear only the keys this test group uses so other tests are unaffected.
    localStorage.removeItem("codex.setupInProgress.p-unit-1")
    localStorage.removeItem("codex.setupInProgress.p-unit-2")
  })

  it("AQU-694: returns false before first mark, true after, false after clear", () => {
    expect(isSetupInProgress("p-unit-1")).toBe(false)
    markSetupInProgress("p-unit-1")
    expect(isSetupInProgress("p-unit-1")).toBe(true)
    // Clear models the flow ending (dismiss or completion) — restore stops.
    clearSetupInProgress("p-unit-1")
    expect(isSetupInProgress("p-unit-1")).toBe(false)
  })

  it("AQU-694: no auto-open — a project the user never opened has no flag", () => {
    markSetupInProgress("p-unit-1")
    // p-unit-2 was never opened, so it must not inherit p-unit-1's flag.
    expect(isSetupInProgress("p-unit-2")).toBe(false)
  })

  it("AQU-694: scoping holds — flags are independent per project", () => {
    markSetupInProgress("p-unit-1")
    markSetupInProgress("p-unit-2")
    clearSetupInProgress("p-unit-1")
    // Clearing A must not clear B.
    expect(isSetupInProgress("p-unit-1")).toBe(false)
    expect(isSetupInProgress("p-unit-2")).toBe(true)
  })
})
