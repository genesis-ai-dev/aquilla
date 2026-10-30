import { describe, it, expect } from "vitest"
import { draftingSettingsProblem, readDraftingSettings } from "./drafting-settings"
import { validateSettingsKeyValue } from "./project-settings-keys"

describe("draftingSettings (AQU-2259)", () => {
  it("accepts every field at a sensible value", () => {
    expect(draftingSettingsProblem({
      provider: "custom", endpoint: "https://openrouter.ai/api/v1", model: "x/y", maxTokens: 16384,
      temperature: 0.3, llmHealthPenalty: 0.1, top_k: 10, contextSize: "medium",
      useOnlyValidatedExamples: true, main_chat_language: "", fewShotExampleFormat: "source-and-target",
      completionBatchSize: 10, validationBatchSize: 0,
    })).toBeNull()
    expect(draftingSettingsProblem({})).toBeNull()
  })

  it("refuses any AI key by name", () => {
    expect(draftingSettingsProblem({ apiKey: "sk" })).toMatch(/apiKey/)
    expect(validateSettingsKeyValue("draftingSettings", { apiKey: "sk" })).toMatch(/apiKey/)
  })

  it("refuses unknown fields, wrong types and out-of-range numbers", () => {
    expect(draftingSettingsProblem({ nope: 1 })).toMatch(/nope/)
    expect(draftingSettingsProblem({ top_k: 2.5 })).toMatch(/whole number/)
    expect(draftingSettingsProblem({ top_k: 51 })).toMatch(/between/)
    expect(draftingSettingsProblem({ provider: "openai" })).toMatch(/provider/)
    expect(draftingSettingsProblem([])).toMatch(/object/)
  })

  it("reads a stored value, dropping only what is malformed", () => {
    expect(readDraftingSettings({ top_k: 7, contextSize: "huge", apiKey: "sk" })).toEqual({ top_k: 7 })
    expect(readDraftingSettings("nope")).toBeNull()
    expect(readDraftingSettings(undefined)).toBeNull()
  })
})
