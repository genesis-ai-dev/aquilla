import { describe, it, expect } from "vitest"
import { draftingSettingsProblem, readDraftingSettings } from "../../../db/shared/drafting-settings"
import {
  applyDraftingSettings,
  draftingDiffersFromDefaults,
  draftingSettingsFrom,
  draftingSettingsToUpload,
} from "./drafting-settings"
import type { CompletionSettings } from "@/lib/parsers/types"

const BASE: CompletionSettings = {
  provider: "frontier", endpoint: "", apiKey: "sk-device", model: "", maxTokens: 4096,
  temperature: 0.3, systemPrompt: "Mine", top_k: 10,
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

// Oct 29 second pass: the Health penalty had no reader, so it is no longer
// written or read. An old stored value is still accepted, and ignored.
describe("the retired Health penalty", () => {
  it("is never written to the shared value", () => {
    expect(draftingSettingsFrom({ ...BASE, llmHealthPenalty: 0.3 } as never)).not.toHaveProperty("llmHealthPenalty")
  })

  it("is ignored when an old shared value still has it", () => {
    expect(readDraftingSettings({ top_k: 7, llmHealthPenalty: 0.3 })).toEqual({ top_k: 7 })
    expect(draftingDiffersFromDefaults(draftingSettingsFrom({ ...BASE, llmHealthPenalty: 0.4 } as never))).toBe(false)
  })

  it("is still accepted by the server's check, so an old blob saves", () => {
    expect(draftingSettingsProblem({ top_k: 7, llmHealthPenalty: 0.3 })).toBeNull()
  })
})

