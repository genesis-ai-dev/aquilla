import { describe, expect, it } from "vitest"
import { resolveActiveSourceLanguage } from "./project-workspace-source-language"

describe("resolveActiveSourceLanguage (AQU-848)", () => {
  it("uses the project source language, ignoring the file's import-time stamp", () => {
    // The reported regression: a project configured for Gom kept reporting
    // English because a file imported earlier carried an English stamp.
    expect(resolveActiveSourceLanguage("English", "Gom")).toBe("Gom")
    expect(resolveActiveSourceLanguage("en", "Gom")).toBe("Gom")
    expect(resolveActiveSourceLanguage("en", "gom")).toBe("gom")
  })

  it("reflects a changed setting without recreating the project", () => {
    // Same stamped file, new project setting — the editor must follow the
    // setting, not the stamp.
    const stamped = "English"
    expect(resolveActiveSourceLanguage(stamped, "English")).toBe("English")
    expect(resolveActiveSourceLanguage(stamped, "Gom")).toBe("Gom")
  })

  it("holds for a language with no ISO shortcut, not just major languages", () => {
    // The source field is free text; an unrecognized tag or a full name must
    // survive untouched rather than being normalized toward a major language.
    expect(resolveActiveSourceLanguage("en", "Konkani (Goan)")).toBe("Konkani (Goan)")
    expect(resolveActiveSourceLanguage(null, "xyz-Latn-x-custom")).toBe("xyz-Latn-x-custom")
  })

  it("returns undefined when the project has no source, even if a file carries one", () => {
    // A stamped value must never surface as though it were configured — the
    // caller decides what to show when the project source is unset.
    expect(resolveActiveSourceLanguage("English", null)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", undefined)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", "")).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", "   ")).toBeUndefined()
    expect(resolveActiveSourceLanguage(null, null)).toBeUndefined()
  })

  it("does not regress projects whose source really is English", () => {
    expect(resolveActiveSourceLanguage("Gom", "English")).toBe("English")
    expect(resolveActiveSourceLanguage(undefined, "English")).toBe("English")
    expect(resolveActiveSourceLanguage(undefined, "en")).toBe("en")
  })
})
