import { describe, expect, it } from "vitest"
import { idmlDraftRejectionProperties, idmlTelemetryProperties } from "./telemetry"

describe("IDML non-content telemetry", () => {
  it("emits only aggregate contract fields and typed failure codes", () => {
    const properties = idmlTelemetryProperties({
      cells: [{
        metadata: {
          idml: {
            version: 2,
            editableSlotIndexes: [0, 2],
            protectedTokenCount: 3,
          },
          sourceText: "must not escape",
        },
      }],
      report: {
        translated: 1,
        unchanged: 0,
        missing: 1,
        rejected: 1,
        unsupported: 0,
        changedMemberPaths: ["Stories/secret.xml"],
        originalByteLength: 100,
        exportedByteLength: 112,
        sizeDelta: 12,
        warnings: [{
          code: "LOCATOR_STALE",
          severity: "error",
          message: "Secret source detail",
        }],
      },
      durationMs: 12.6,
    })

    expect(properties).toEqual({
      profile_version: 2,
      unit_count: 1,
      editable_slot_count: 2,
      protected_token_count: 3,
      failure_codes: ["LOCATOR_STALE"],
      mapping_failures: 2,
      export_size_delta: 12,
      validation_duration_ms: 13,
    })
    expect(JSON.stringify(properties)).not.toMatch(/secret|Stories\//i)
  })
})

describe("IDML draft rejection telemetry (AQU-1964)", () => {
  it("counts the refusal by code and mode, carrying no locator or text", () => {
    const properties = idmlDraftRejectionProperties({
      cells: [{
        metadata: {
          idml: {
            version: 2,
            editableSlotIndexes: [0, 2],
            protectedTokenCount: 3,
          },
          sourceText: "must not escape",
        },
      }],
      diagnostics: [{
        code: "ANCHOR_REORDERED",
        severity: "error",
        message: "Secret source detail",
        memberPath: "Stories/Story_u363.xml",
      }],
      mode: "single",
      repairAttempted: true,
    })

    expect(properties).toEqual({
      profile_version: 2,
      unit_count: 1,
      editable_slot_count: 2,
      protected_token_count: 3,
      failure_codes: ["ANCHOR_REORDERED"],
      mapping_failures: 0,
      export_size_delta: 0,
      validation_duration_ms: 0,
      draft_mode: "single",
      repair_attempted: true,
    })
    expect(JSON.stringify(properties)).not.toMatch(/secret|Stories\/|part-/i)
  })
})
