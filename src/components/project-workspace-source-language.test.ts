import { describe, expect, it } from "vitest"
import { resolveActiveSourceLanguage } from "./project-workspace-source-language"

const gom = { sourceLanguage: "Gom" }

describe("resolveActiveSourceLanguage (AQU-848)", () => {
  it("uses the source lane's migration fallback, ignoring the file's import-time stamp", () => {
    // The reported regression: a project configured for Gom kept reporting
    // English because a file imported earlier carried an English stamp.
    // With no source row yet, laneLanguage answers from settings.
    expect(resolveActiveSourceLanguage("English", gom)).toBe("Gom")
    expect(resolveActiveSourceLanguage("en", gom)).toBe("Gom")
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "gom" })).toBe("gom")
  })

  it("reflects a changed setting without recreating the project", () => {
    // Same stamped file, new project setting — the editor must follow the
    // setting, not the stamp, until the source lane carries its own language.
    const stamped = "English"
    expect(resolveActiveSourceLanguage(stamped, { sourceLanguage: "English" })).toBe("English")
    expect(resolveActiveSourceLanguage(stamped, gom)).toBe("Gom")
  })

  it("holds for a language with no ISO shortcut, not just major languages", () => {
    // The source field is free text; an unrecognized tag or a full name must
    // survive untouched rather than being normalized toward a major language.
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "Konkani (Goan)" })).toBe("Konkani (Goan)")
    expect(resolveActiveSourceLanguage(null, { sourceLanguage: "xyz-Latn-x-custom" })).toBe(
      "xyz-Latn-x-custom",
    )
  })

  it("returns undefined when the project has no source, even if a file carries one", () => {
    // A stamped value must never surface as though it were configured — the
    // caller decides what to show when the project source is unset.
    expect(resolveActiveSourceLanguage("English", null)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", undefined)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "" })).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "   " })).toBeUndefined()
    expect(resolveActiveSourceLanguage(null, null)).toBeUndefined()
  })

  it("does not regress projects whose source really is English", () => {
    expect(resolveActiveSourceLanguage("Gom", { sourceLanguage: "English" })).toBe("English")
    expect(resolveActiveSourceLanguage(undefined, { sourceLanguage: "English" })).toBe("English")
    expect(resolveActiveSourceLanguage(undefined, { sourceLanguage: "en" })).toBe("en")
  })

  it("uses a typed source-lane language and does not let settings override it (AQU-1593)", () => {
    const lane = {
      id: "50dce001",
      role: "source" as const,
      language: "Gom",
      name: "English",
      langCode: "en",
      legacyTag: null,
    }
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "English" }, lane)).toBe("Gom")
  })

  it("falls back to settings for an unbackfilled source lane (AQU-1593)", () => {
    const lane = {
      id: "50dce001",
      role: "source" as const,
      language: null,
      name: "Source",
      langCode: null,
      legacyTag: null,
    }
    expect(resolveActiveSourceLanguage("en", gom, lane)).toBe("Gom")
  })
})
