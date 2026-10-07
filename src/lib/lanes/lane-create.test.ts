import { describe, expect, it } from "vitest"
import { planNewTargetLane } from "./lane-create"

const spanishDefault = [
  { id: "src", name: "English", language: "English", legacyTag: null },
  { id: "def", name: "Spanish", language: "Spanish", legacyTag: "" },
]

describe("planNewTargetLane", () => {
  it("uses the language string as the tag for the first extra lane", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "Yoruba",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: spanishDefault,
    })
    expect(plan).toEqual({
      ok: true,
      language: "Yoruba",
      name: "Yoruba",
      legacyTag: "Yoruba",
      langCode: null,
    })
  })

  it("gives a second lane of the same language the opaque id as its tag", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "Yoruba Team",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: [
        ...spanishDefault,
        { id: "yo1", name: "Yoruba", language: "Yoruba", legacyTag: "Yoruba" },
      ],
    })
    expect(plan).toMatchObject({
      ok: true,
      language: "Yoruba",
      name: "Yoruba Team",
      legacyTag: "aabbccdd",
    })
  })

  it("does not reuse the default language string as a second lane's tag", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "Spanish Team",
      language: "Spanish",
      targetLanguage: "Spanish",
      existing: spanishDefault,
    })
    expect(plan).toMatchObject({ ok: true, legacyTag: "aabbccdd" })
  })

  it("refuses a duplicate display name", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "yoruba",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: [
        ...spanishDefault,
        { id: "yo1", name: "Yoruba", language: "Yoruba", legacyTag: "Yoruba" },
      ],
    })
    expect(plan).toEqual({ ok: false, problem: "duplicate" })
  })

  // ── AQU-1592 ──────────────────────────────────────────────────────────────

  it("stores no name when the user gave none — the lane shows its language", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: spanishDefault,
    })
    // The name is NOT backfilled from the language: a stored "Yoruba" would
    // survive the language later being corrected, which is the AQU-1585 drift.
    expect(plan).toMatchObject({ ok: true, language: "Yoruba", name: null })
  })

  it("never derives a language code — only an override is stored", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "",
      language: "Spanish",
      targetLanguage: "Yoruba",
      existing: [{ id: "src", name: "English", language: "English", legacyTag: null }],
    })
    // "Spanish" maps to "es" in the catalog, but the code is derived on READ.
    expect(plan).toMatchObject({ ok: true, langCode: null })
  })

  it("canonicalizes a code override's case", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "",
      language: "Spanish",
      code: "es-mx",
      targetLanguage: "Yoruba",
      existing: [],
    })
    expect(plan).toMatchObject({ ok: true, langCode: "es-MX" })
  })

  it("refuses a malformed code override rather than dropping it", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "",
      language: "Spanish",
      code: "not a tag!",
      targetLanguage: "Yoruba",
      existing: [],
    })
    expect(plan).toEqual({ ok: false, problem: "malformed_code" })
  })

  it("refuses a lane with neither a language nor a name", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "   ",
      language: "  ",
      targetLanguage: "Spanish",
      existing: spanishDefault,
    })
    expect(plan).toEqual({ ok: false, problem: "empty" })
  })

  it("collides with an existing lane that only carries a language", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "Yoruba",
      language: "Yoruba",
      targetLanguage: "Spanish",
      // This lane stores no name — it DISPLAYS "Yoruba" via its language, so a
      // new lane named "Yoruba" is still a visible duplicate.
      existing: [
        ...spanishDefault,
        { id: "yo1", name: null, language: "Yoruba", legacyTag: "Yoruba" },
      ],
    })
    expect(plan).toEqual({ ok: false, problem: "duplicate" })
  })
})
