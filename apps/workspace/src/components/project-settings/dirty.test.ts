import { describe, it, expect } from "vitest"
import { isSettingsDirty, type SettingsFormSnapshot } from "./dirty"

function snap(overrides: Partial<SettingsFormSnapshot> = {}): SettingsFormSnapshot {
  return {
    name: "Project",
    sourceLanguage: "en",
    targetLanguage: "sw",
    username: "ryder",
    provider: "frontier",
    endpoint: "",
    apiKey: "",
    model: "",
    maxTokens: 512,
    temperature: 0.3,
    systemPrompt: "Translate carefully.",
    llmHealthPenalty: 0.1,
    autoSyncEnabled: false,
    autoSyncInterval: 5,
    ...overrides,
  }
}

describe("isSettingsDirty", () => {
  it("returns false when form state matches loaded snapshot", () => {
    const loaded = snap()
    const current = snap()
    expect(isSettingsDirty(loaded, current)).toBe(false)
  })

  it("returns true when name differs", () => {
    expect(isSettingsDirty(snap(), snap({ name: "Changed" }))).toBe(true)
  })

  it("returns true when systemPrompt differs", () => {
    expect(isSettingsDirty(snap(), snap({ systemPrompt: "New" }))).toBe(true)
  })

  it("returns true when a numeric field differs", () => {
    expect(isSettingsDirty(snap(), snap({ maxTokens: 1024 }))).toBe(true)
  })

  it("returns false when loaded snapshot is null (initial load)", () => {
    expect(isSettingsDirty(null, snap())).toBe(false)
  })
})
