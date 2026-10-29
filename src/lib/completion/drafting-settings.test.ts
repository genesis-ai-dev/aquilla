import { describe, it, expect } from "vitest"
import {
  applyDraftingSettings,
  draftingDiffersFromDefaults,
  draftingSettingsFrom,
  draftingSettingsToUpload,
} from "./drafting-settings"
import type { CompletionSettings } from "@/lib/parsers/types"

const BASE: CompletionSettings = {
  provider: "frontier", endpoint: "", apiKey: "sk-device", model: "", maxTokens: 4096,
  temperature: 0.3, systemPrompt: "Mine", llmHealthPenalty: 0.1, top_k: 10,
  contextSize: "medium", main_chat_language: "", fewShotExampleFormat: "source-and-target",
}

describe("drafting settings in the SPA (AQU-2259)", () => {
  it("never carries the key or the instructions", () => {
    const shared = draftingSettingsFrom(BASE)
    expect(JSON.stringify(shared)).not.toContain("sk-device")
    expect(JSON.stringify(shared)).not.toContain("Mine")
  })

  it("treats an old default snapshot as defaults, and the endpoint only counts for a custom provider", () => {
    expect(draftingDiffersFromDefaults(draftingSettingsFrom(BASE))).toBe(false)
    expect(draftingDiffersFromDefaults(draftingSettingsFrom({ ...BASE, endpoint: "https://x" , provider: "frontier" }))).toBe(false)
    expect(draftingDiffersFromDefaults(draftingSettingsFrom({ ...BASE, top_k: 12 }))).toBe(true)
  })

  it("lays the team's values over a record and keeps the record's key and instructions", () => {
    const out = applyDraftingSettings(BASE, { top_k: 4 })
    expect(out.top_k).toBe(4)
    expect(out.apiKey).toBe("sk-device")
    expect(out.systemPrompt).toBe("Mine")
  })

  it("uploads only for an editor, only when the team has none, only when tuned", () => {
    const tuned = { ...BASE, temperature: 0.8 }
    expect(draftingSettingsToUpload({ canEdit: true, serverDrafting: null, local: tuned })).toMatchObject({ temperature: 0.8 })
    expect(draftingSettingsToUpload({ canEdit: false, serverDrafting: null, local: tuned })).toBeNull()
    expect(draftingSettingsToUpload({ canEdit: true, serverDrafting: {}, local: tuned })).toBeNull()
    expect(draftingSettingsToUpload({ canEdit: true, serverDrafting: null, local: BASE })).toBeNull()
  })
})
