import { describe, expect, it } from "vitest"
import { runCheck, suggestionFor } from "./old-orthography"
import { CANONICAL_APOSTROPHE, type OrthographyProfile } from "../../../../db/shared/orthography"

const uzbek: OrthographyProfile = {
  rules: [
    ["sh", "ş"],
    ["ch", "ç"],
    ["oʻ", "ö"],
    ["gʻ", "ğ"],
  ],
  apostrophe: CANONICAL_APOSTROPHE,
  exceptions: [{ word: "Isʼhoq", status: "approved" }],
}

describe("old-orthography check", () => {
  it("says nothing without the Language profile slot", () => {
    expect(runCheck("source", "shahar va chiroq")).toBeNull()
    expect(runCheck("source", "shahar", { orthography: null })).toBeNull()
  })

  it("flags each old-spelling word in the target", () => {
    expect(runCheck("city and lamp", "shahar va chiroq", { orthography: uzbek })).toEqual([
      { side: "target", start: 0, end: 6, matchedText: "shahar" },
      { side: "target", start: 10, end: 16, matchedText: "chiroq" },
    ])
  })

  it("judges the target, never the source", () => {
    expect(runCheck("shahar", "şahar", { orthography: uzbek })).toBeNull()
  })

  it("never flags an approved exception, suffix and all", () => {
    expect(runCheck("Isaac's", "Ishoqning kitobi", { orthography: uzbek })).toBeNull()
  })

  it("stays quiet on text already in the new orthography", () => {
    expect(runCheck("source", "Boşida Xudo osmon va yerni yaratdi.", { orthography: uzbek })).toBeNull()
  })

  it("names the word and the spelling the lane wants", () => {
    const spans = runCheck("city", "shahar", { orthography: uzbek })!
    expect(suggestionFor(spans, { orthography: uzbek })).toEqual({ word: "shahar", suggestion: "şahar" })
  })

  it("offers no suggestion without the slot", () => {
    expect(suggestionFor([{ side: "target", start: 0, end: 6, matchedText: "shahar" }], undefined)).toBeNull()
  })
})
