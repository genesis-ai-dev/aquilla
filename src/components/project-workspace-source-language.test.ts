import { describe, expect, it } from "vitest"
import { resolveActiveSourceLanguage } from "./project-workspace-source-language"

const gom = { sourceLanguage: "Gom" }

function sourceLane(language: string | null, name: string | null = null) {
  return {
    id: "50dce001",
    role: "source" as const,
    language,
    name,
    langCode: null,
    legacyTag: null,
  }
}

describe("resolveActiveSourceLanguage (AQU-848)", () => {
  it("ignores the file stamp and project settings when there is no source row", () => {
    // The reported regression: a project configured for Gom kept reporting
    // English because a file imported earlier carried an English stamp.
    // AQU-1595: with no source row, settings are not that configuration.
    expect(resolveActiveSourceLanguage("English", gom)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", gom)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "gom" })).toBeUndefined()
  })

  it("follows the source lane's language, ignoring a settings change and the file stamp", () => {
    const stamped = "English"
    expect(resolveActiveSourceLanguage(stamped, { sourceLanguage: "Gom" }, sourceLane("English"))).toBe("English")
    expect(resolveActiveSourceLanguage(stamped, { sourceLanguage: "English" }, sourceLane("Gom"))).toBe("Gom")
  })

  it("holds for a language with no ISO shortcut, not just major languages", () => {
    // The source field is free text; an unrecognized tag or a full name must
    // survive untouched rather than being normalized toward a major language.
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "English" }, sourceLane("Konkani (Goan)"))).toBe(
      "Konkani (Goan)",
    )
    expect(
      resolveActiveSourceLanguage(null, { sourceLanguage: "en" }, sourceLane("xyz-Latn-x-custom")),
    ).toBe("xyz-Latn-x-custom")
  })

  it("returns undefined when the project has no source, even if a file carries one", () => {
    // A stamped value must never surface as though it were configured — the
    // caller decides what to show when the project source is unset.
    expect(resolveActiveSourceLanguage("English", null)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", undefined)).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "" })).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "   " })).toBeUndefined()
    expect(resolveActiveSourceLanguage("en", gom, sourceLane(null, "   "))).toBeUndefined()
    expect(resolveActiveSourceLanguage(null, null)).toBeUndefined()
  })

  it("does not regress a source lane whose language really is English", () => {
    expect(resolveActiveSourceLanguage("Gom", gom, sourceLane("English"))).toBe("English")
    expect(resolveActiveSourceLanguage(undefined, { sourceLanguage: "Gom" }, sourceLane("en"))).toBe("en")
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

  it("uses an unbackfilled source lane's name and ignores settings (AQU-1595)", () => {
    expect(resolveActiveSourceLanguage("en", { sourceLanguage: "English" }, sourceLane(null, "Gom"))).toBe("Gom")
    // A stored placeholder name is the name fallback. Settings do not replace it.
    expect(resolveActiveSourceLanguage("en", gom, sourceLane(null, "Source"))).toBe("Source")
  })
})
