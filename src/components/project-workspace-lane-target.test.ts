import { describe, expect, it } from "vitest"
import { resolveActiveTargetLanguage } from "./project-workspace-lane-target"

describe("resolveActiveTargetLanguage (AQU-602)", () => {
  it("uses the active lane tag as the target language for a non-default lane", () => {
    // Switching to the 'es' lane must translate into Spanish, regardless of the
    // file/project default target — the core AQU-602 regression.
    expect(resolveActiveTargetLanguage("es", "fr", "fr")).toBe("es")
    expect(resolveActiveTargetLanguage("swh", undefined, "fr")).toBe("swh")
    expect(resolveActiveTargetLanguage("fr-CA", "fr-BE", "French")).toBe("fr-CA")
  })

  it("uses only the project target for the default lane, ignoring the file (AQU-583)", () => {
    // The per-file target is an import-time snapshot. On the default lane the
    // project setting is authoritative: it wins over any file value...
    expect(resolveActiveTargetLanguage("", "fr", "es")).toBe("es")
    expect(resolveActiveTargetLanguage("", null, "es")).toBe("es")
    expect(resolveActiveTargetLanguage("", undefined, "es")).toBe("es")
  })

  it("returns undefined when the project has no target, even if a file carries one (AQU-583)", () => {
    // ...and when the project has no target the default lane has none — so the
    // caller shows "Set target language" rather than a stamped file language
    // (e.g. "English"), regardless of how many files were imported.
    expect(resolveActiveTargetLanguage("", "English", null)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", "fr", undefined)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", "fr", "")).toBeUndefined()
    expect(resolveActiveTargetLanguage("", null, null)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", undefined, undefined)).toBeUndefined()
  })
})
