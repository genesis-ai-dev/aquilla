// The overlay that puts the shared project-settings blob onto a ProjectRecord.
// Project Settings now builds its form from this on a direct load, so a key the
// overlay drops is a setting that page shows as its default (PR1 leftover #2).

import { describe, it, expect } from "vitest"
import { overlayProjectSettings } from "./overlay-project-settings"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "./project-settings"

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

describe("overlayProjectSettings", () => {
  it("carries the text validation trio and count", () => {
    const out = overlayProjectSettings(makeRecord(), {
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
    const out = overlayProjectSettings(makeRecord({ allowSelfValidation: true }), {
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
    const out = overlayProjectSettings(makeRecord(), { harmonize_min_role: "maintainer" })
    expect(out.harmonize_min_role).toBe("maintainer")
  })

  it("carries stored false booleans and the rest of the Settings-page fields", () => {
    const blob: ProjectWideSettings = {
      sourceLanguage: "English",
      targetLanguage: "French",
      allowTrackEditing: true,
      timingLocked: false,
      cellEditingFloor: "contributor",
      bibleResourcesEnabled: false,
      importExcludeFrontMatter: true,
      draftContext: { precedingTargetCells: 4 },
      termMatching: { prefixes: ["re"], suffixes: [] },
    }
    const out = overlayProjectSettings(makeRecord({ timingLocked: true }), blob)
    expect(out.sourceLanguage).toBe("English")
    expect(out.targetLanguage).toBe("French")
    expect(out.allowTrackEditing).toBe(true)
    expect(out.timingLocked).toBe(false)
    expect(out.cellEditingFloor).toBe("contributor")
    expect(out.bibleResourcesEnabled).toBe(false)
    expect(out.importExcludeFrontMatter).toBe(true)
    expect(out.draftContext).toEqual({ precedingTargetCells: 4 })
    expect(out.termMatching).toEqual({ prefixes: ["re"], suffixes: [] })
  })

  it("skips null and undefined so absent stays absent", () => {
    const record = makeRecord({ allowSelfValidation: false, harmonize_min_role: "maintainer" })
    const out = overlayProjectSettings(record, {
      allowSelfValidation: undefined,
      harmonize_min_role: null as unknown as undefined,
    })
    expect(out.allowSelfValidation).toBe(false)
    expect(out.harmonize_min_role).toBe("maintainer")
    expect(out.bibleResourcesEnabled).toBeUndefined()
  })

  it("returns the input by reference when nothing changes, and never mutates it", () => {
    const record = makeRecord({ validationCount: 2, allowSelfValidation: false })
    expect(overlayProjectSettings(record, {})).toBe(record)
    expect(overlayProjectSettings(record, { validationCount: 2, allowSelfValidation: false })).toBe(record)

    const out = overlayProjectSettings(record, { validationCount: 3 })
    expect(out).not.toBe(record)
    expect(record.validationCount).toBe(2)
  })
})
