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

  it("prefers the project target over the file target for the default lane (AQU-583)", () => {
    // The per-file target is an import-time snapshot; a Settings change to the
    // project target must win on the default lane regardless of how many files
    // were imported (each stamped with its own target).
    expect(resolveActiveTargetLanguage("", "fr", "es")).toBe("es")
  })

  it("falls back to the file target when the project has none (default lane, AQU-249)", () => {
    expect(resolveActiveTargetLanguage("", "fr", null)).toBe("fr")
    expect(resolveActiveTargetLanguage("", "fr", undefined)).toBe("fr")
    expect(resolveActiveTargetLanguage("", "fr", "")).toBe("fr")
  })

  it("uses the project target when the file has none (default lane)", () => {
    expect(resolveActiveTargetLanguage("", null, "es")).toBe("es")
    expect(resolveActiveTargetLanguage("", undefined, "es")).toBe("es")
  })

  it("returns undefined when the default lane has no target anywhere", () => {
    expect(resolveActiveTargetLanguage("", null, null)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", undefined, undefined)).toBeUndefined()
  })
})
