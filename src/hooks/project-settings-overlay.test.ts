// The overlay that puts the shared project-settings blob onto a ProjectRecord.
// Project Settings now builds its form from this on a direct load, so a key the
// overlay drops is a setting that page shows as its default (PR1 leftover #2).

import { describe, it, expect } from "vitest"
import { overlaySettings } from "./project-settings-overlay"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

function makeRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "Overlay",
    files: [],
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  } as unknown as ProjectRecord
}

describe("overlaySettings", () => {
  // AQU-1771: the workspace passes the org's validation defaults so every
  // reader of the record sees the threshold actually in force.
  it("takes the org's validation defaults when the project has none", () => {
    const out = overlaySettings(makeRecord(), {}, null, { validationCount: 3, validationCountAudio: 2 })
    expect(out.validationCount).toBe(3)
    expect(out.validationCountAudio).toBe(2)
  })

  it("keeps the project's own numbers over the org's", () => {
    const out = overlaySettings(
      makeRecord(), { validationCount: 1, validationCountAudio: 4 }, null,
      { validationCount: 3, validationCountAudio: 2 },
    )
    expect(out.validationCount).toBe(1)
    expect(out.validationCountAudio).toBe(4)
  })

  it("leaves the count unset without org defaults (the Project settings form's view)", () => {
    const out = overlaySettings(makeRecord(), {})
    expect(out.validationCount).toBeUndefined()
  })

  it("carries the text validation trio and count", () => {
    const out = overlaySettings(makeRecord(), {
      validationCount: 2,
      validationRoleFloor: "project_lead",
      validationNamedUsers: ["ana"],
      allowSelfValidation: false,
    })
    expect(out.validationCount).toBe(2)
    expect(out.validationRoleFloor).toBe("project_lead")
    expect(out.validationNamedUsers).toEqual(["ana"])
    expect(out.allowSelfValidation).toBe(false)
  })

  it("carries the audio validation trio and count as separate keys", () => {
    const out = overlaySettings(makeRecord({ allowSelfValidation: true }), {
      validationCountAudio: 3,
      validationRoleFloorAudio: "maintainer",
      validationNamedUsersAudio: ["dev", "alice"],
      allowSelfValidationAudio: false,
    })
    expect(out.validationCountAudio).toBe(3)
    expect(out.validationRoleFloorAudio).toBe("maintainer")
    expect(out.validationNamedUsersAudio).toEqual(["dev", "alice"])
    expect(out.allowSelfValidationAudio).toBe(false)
    // The audio policy never leaks into the text one.
    expect(out.allowSelfValidation).toBe(true)
  })

  it("carries the harmonize floor, which the overlay used to drop", () => {
    const out = overlaySettings(makeRecord(), { harmonize_min_role: "maintainer" })
    expect(out.harmonize_min_role).toBe("maintainer")
  })

  // AQU-1686: the settings card showed a stored {voices: "off"} as a switch
  // that is on. The overlay now reads the value the way the server does.
  it("drops unknown enrichment ids and values that are not booleans", () => {
    const blob = { bibleEnrichments: { voices: "off", nope: true, places: false } } as unknown as ProjectWideSettings
    const out = overlaySettings(makeRecord({}), blob)
    expect(out.bibleEnrichments).toEqual({ places: false })
  })

  it("carries stored false booleans and the rest of the Settings-page fields", () => {
    const blob: ProjectWideSettings = {
      sourceLanguage: "English",
      targetLanguage: "French",
      allowTrackEditing: true,
      timingLocked: false,
      cellEditingFloor: "contributor",
      bibleResourcesEnabled: false,
      bibleEnrichments: { voices: false, autopilot: true },
      languageProfile: {
        quoteMarks: { levels: [{ open: "«", close: "»" }], continuation: "continuation-mark" },
      },
      bibleVoiceOverrides: { "sp:a-b": { speaker: "person:Jesus", note: "FCBH", by: "mara", at: "2026-10-06T00:00:00Z" } },
      importExcludeFrontMatter: true,
      draftContext: { precedingTargetCells: 4 },
      termMatching: { prefixes: ["re"], suffixes: [] },
    }
    const out = overlaySettings(makeRecord({ timingLocked: true }), blob)
    expect(out.sourceLanguage).toBe("English")
    expect(out.targetLanguage).toBe("French")
    expect(out.allowTrackEditing).toBe(true)
    expect(out.timingLocked).toBe(false)
    expect(out.cellEditingFloor).toBe("contributor")
    expect(out.bibleResourcesEnabled).toBe(false)
    // AQU-1686: a dropped key would load layers for enrichments the project
    // switched off.
    expect(out.bibleEnrichments).toEqual({ voices: false, autopilot: true })
    // AQU-1688: a dropped profile would leave Bible data checks dormant for a
    // project that has set its quotation marks.
    expect(out.languageProfile?.quoteMarks?.levels).toEqual([{ open: "«", close: "»" }])
    // AQU-1692: a dropped key would save a maintainer's voice correction and
    // never show it.
    expect(out.bibleVoiceOverrides?.["sp:a-b"]?.speaker).toBe("person:Jesus")
    expect(out.importExcludeFrontMatter).toBe(true)
    expect(out.draftContext).toEqual({ precedingTargetCells: 4 })
    expect(out.termMatching).toEqual({ prefixes: ["re"], suffixes: [] })
  })

  it("skips null and undefined so absent stays absent", () => {
    const record = makeRecord({ allowSelfValidation: false, harmonize_min_role: "maintainer" })
    const out = overlaySettings(record, {
      allowSelfValidation: undefined,
      harmonize_min_role: null as unknown as undefined,
    })
    expect(out.allowSelfValidation).toBe(false)
    expect(out.harmonize_min_role).toBe("maintainer")
    expect(out.bibleResourcesEnabled).toBeUndefined()
  })

  it("returns the input by reference when nothing changes, and never mutates it", () => {
    const record = makeRecord({ validationCount: 2, allowSelfValidation: false })
    expect(overlaySettings(record, {})).toBe(record)
    expect(overlaySettings(record, { validationCount: 2, allowSelfValidation: false })).toBe(record)

    const out = overlaySettings(record, { validationCount: 3 })
    expect(out).not.toBe(record)
    expect(record.validationCount).toBe(2)
  })
})

describe("overlaySettings — AQU-1768 org media defaults", () => {
  const media = {
    timingLocked: false,
    allowTrackEditing: true,
    cellEditingFloor: "project_lead" as const,
    allowSelfValidationAudio: false,
    validationRoleFloorAudio: "maintainer" as const,
  }

  it("fills every media key the project does not set from the org", () => {
    const out = overlaySettings(makeRecord(), {}, undefined, { media })
    expect(out.timingLocked).toBe(false)
    expect(out.allowTrackEditing).toBe(true)
    expect(out.cellEditingFloor).toBe("project_lead")
    expect(out.allowSelfValidationAudio).toBe(false)
    expect(out.validationRoleFloorAudio).toBe("maintainer")
  })

  it("keeps the project's own value over the org's", () => {
    const out = overlaySettings(
      makeRecord(),
      { timingLocked: true, allowTrackEditing: false, cellEditingFloor: "none" },
      undefined,
      { media },
    )
    expect(out.timingLocked).toBe(true)
    expect(out.allowTrackEditing).toBe(false)
    expect(out.cellEditingFloor).toBe("none")
    // Keys the project left unset still follow the org.
    expect(out.validationRoleFloorAudio).toBe("maintainer")
  })

  it("without org defaults, leaves the record as the project's own settings say", () => {
    const out = overlaySettings(makeRecord(), {})
    expect(out.timingLocked).toBeUndefined()
    expect(out.cellEditingFloor).toBeUndefined()
  })
})

// AQU-2259: the drafting settings (the "AI Instructions" card, the model
// choice and the Health penalty) are the team's, so the shared value wins
// over whatever this browser kept. The project's own AI key never travels
// through the blob and must survive the overlay untouched.
describe("overlaySettings — the team's drafting settings (AQU-2259)", () => {
  const localCompletion = {
    provider: "frontier" as const,
    endpoint: "",
    apiKey: "sk-this-browser-only",
    model: "",
    maxTokens: 16384,
    temperature: 0.3,
    systemPrompt: "Local copy of the instructions",
    llmHealthPenalty: 0.1,
    top_k: 10,
    contextSize: "medium" as const,
    main_chat_language: "",
    fewShotExampleFormat: "source-and-target" as const,
  }

  it("puts the shared values on the record and keeps this browser's key", () => {
    const out = overlaySettings(makeRecord({ completionSettings: localCompletion }), {
      draftingSettings: {
        provider: "custom",
        endpoint: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-3.5-sonnet",
        temperature: 0.7,
        llmHealthPenalty: 0.25,
        top_k: 17,
        contextSize: "large",
        fewShotExampleFormat: "target-only",
        main_chat_language: "French",
        completionBatchSize: 20,
        validationBatchSize: 40,
      },
    })
    expect(out.completionSettings).toMatchObject({
      provider: "custom",
      endpoint: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      temperature: 0.7,
      llmHealthPenalty: 0.25,
      top_k: 17,
      contextSize: "large",
      fewShotExampleFormat: "target-only",
      main_chat_language: "French",
      completionBatchSize: 20,
      validationBatchSize: 40,
      apiKey: "sk-this-browser-only",
    })
  })

  it("reads a field the team left unset as its default, never this browser's copy", () => {
    const out = overlaySettings(
      makeRecord({ completionSettings: { ...localCompletion, top_k: 3, temperature: 0.9 } }),
      { draftingSettings: { model: "team-model" } },
    )
    expect(out.completionSettings?.model).toBe("team-model")
    expect(out.completionSettings?.top_k).toBe(10)
    expect(out.completionSettings?.temperature).toBe(0.3)
  })

  it("keeps the shared written instructions on top", () => {
    const out = overlaySettings(makeRecord({ completionSettings: localCompletion }), {
      draftingSettings: { top_k: 12 },
      systemPrompt: "Team instructions",
    })
    expect(out.completionSettings?.systemPrompt).toBe("Team instructions")
    expect(out.completionSettings?.top_k).toBe(12)
  })

  it("leaves this browser's values alone while the team has none yet", () => {
    const record = makeRecord({ completionSettings: { ...localCompletion, top_k: 3 } })
    const out = overlaySettings(record, {})
    expect(out.completionSettings?.top_k).toBe(3)
  })

  it("drops a malformed shared field instead of using it", () => {
    const out = overlaySettings(makeRecord(), {
      draftingSettings: { top_k: 9000, contextSize: "huge" } as never,
    })
    expect(out.completionSettings?.top_k).toBe(10)
    expect(out.completionSettings?.contextSize).toBe("medium")
  })
})
