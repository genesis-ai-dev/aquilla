import { describe, it, expect } from "vitest"
import {
  laneLabelForTag,
  laneLabelsByTag,
  laneLanguageForTag,
  laneRowLabel,
  laneRowLanguage,
  type LaneLanguageRow,
} from "./lane-language"

/** A target lane row as `ProjectSettingsResponse.lanes` returns one. */
function row(over: Partial<LaneLanguageRow> & { id: string }): LaneLanguageRow {
  return { name: "", langCode: null, legacyTag: null, ...over }
}

describe("laneRowLanguage (AQU-1586)", () => {
  it("is the tag when the tag is the language — a working lane is unchanged", () => {
    // Preferring lang_code here would rewrite this lane's "French" into "fra".
    expect(
      laneRowLanguage(row({ id: "frc00002", name: "French", langCode: "fra", legacyTag: "French" })),
    ).toBe("French")
  })

  it("is the lang_code when the tag is the lane's own id", () => {
    // The second Spanish lane of a Spanish project: `name` must be unique among
    // the project's lanes, so the typed language survives only as `lang_code`.
    expect(
      laneRowLanguage(
        row({ id: "a3f09c1e", name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" }),
      ),
    ).toBe("es")
  })

  it("falls back to the name when the language is not in the code registry", () => {
    // `codeForLanguageLabel` returns null for a language it does not know, and
    // then the name is the only record of what the maintainer typed.
    expect(
      laneRowLanguage(row({ id: "b0b0b0b0", name: "Nuer", langCode: null, legacyTag: "b0b0b0b0" })),
    ).toBe("Nuer")
  })

  it("is null rather than the lane id when the row records nothing else", () => {
    expect(laneRowLanguage(row({ id: "a3f09c1e", legacyTag: "a3f09c1e" }))).toBeNull()
    expect(
      laneRowLanguage(row({ id: "a3f09c1e", name: "a3f09c1e", langCode: "a3f09c1e", legacyTag: "a3f09c1e" })),
    ).toBeNull()
  })

  it("skips the default lane's empty tag", () => {
    expect(laneRowLanguage(row({ id: "defa0001", name: "Spanish", langCode: "es", legacyTag: "" }))).toBe("es")
  })
})

describe("laneRowLabel (AQU-1586)", () => {
  it("is the display name the maintainer chose, not the language code", () => {
    expect(
      laneRowLabel(row({ id: "a3f09c1e", name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" })),
    ).toBe("Spanish (Mexico team)")
  })

  it("falls back to lang_code for an unnamed lane", () => {
    expect(laneRowLabel(row({ id: "a3f09c1e", name: "  ", langCode: "es" }))).toBe("es")
  })

  it("is null rather than the lane id", () => {
    expect(laneRowLabel(row({ id: "a3f09c1e", name: "a3f09c1e" }))).toBeNull()
  })
})

describe("laneLanguageForTag (AQU-1586)", () => {
  const lanes: LaneLanguageRow[] = [
    row({ id: "defa0001", name: "Spanish", langCode: "es", legacyTag: "" }),
    row({ id: "a3f09c1e", name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" }),
    row({ id: "frc00002", name: "French (Canada)", langCode: "fra", legacyTag: "fr-CA" }),
  ]

  it("resolves a lane tagged with its own id to the lane's language", () => {
    expect(laneLanguageForTag("a3f09c1e", lanes)).toBe("es")
  })

  it("leaves a lane whose tag is a language exactly as it was", () => {
    expect(laneLanguageForTag("fr-CA", lanes)).toBe("fr-CA")
  })

  it("matches on the lane id too, for a caller holding the id", () => {
    expect(laneLanguageForTag("frc00002", lanes)).toBe("fr-CA")
  })

  it("falls back to the tag when the project carries no lane rows", () => {
    // A server that predates AQU-1418 omits `lanes`; the tag is all there is.
    expect(laneLanguageForTag("Swahili", undefined)).toBe("Swahili")
    expect(laneLanguageForTag("Swahili", [])).toBe("Swahili")
  })

  it("is null when a row exists but records no language", () => {
    expect(laneLanguageForTag("b0b0b0b0", [row({ id: "b0b0b0b0", legacyTag: "b0b0b0b0" })])).toBeNull()
  })
})

describe("laneLabelForTag (AQU-1586)", () => {
  const lanes: LaneLanguageRow[] = [
    row({ id: "a3f09c1e", name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" }),
  ]

  it("never renders a lane id for a lane that has a row", () => {
    expect(laneLabelForTag("a3f09c1e", lanes)).toBe("Spanish (Mexico team)")
  })

  it("always returns a string, falling back to the tag", () => {
    expect(laneLabelForTag("swh", lanes)).toBe("swh")
  })
})

describe("laneLabelsByTag (AQU-1586)", () => {
  it("keys the row's display name by its tag, default lane included", () => {
    expect(
      laneLabelsByTag([
        row({ id: "defa0001", name: "Spanish", legacyTag: "" }),
        row({ id: "a3f09c1e", name: "Spanish (Mexico team)", legacyTag: "a3f09c1e" }),
      ]),
    ).toEqual({ "": "Spanish", a3f09c1e: "Spanish (Mexico team)" })
  })

  it("omits lanes that name nothing, so the caller's own fallback applies", () => {
    expect(laneLabelsByTag([row({ id: "b0b0b0b0", legacyTag: "b0b0b0b0" })])).toEqual({})
  })
})
