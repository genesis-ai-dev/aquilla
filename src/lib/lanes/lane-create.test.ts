import { describe, expect, it } from "vitest"
import { planNewTargetLane } from "./lane-create"

const spanishDefault = [
  { id: "src", name: "English", legacyTag: null },
  { id: "def", name: "Spanish", legacyTag: "" },
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
    expect(plan).toEqual({ ok: true, name: "Yoruba", legacyTag: "Yoruba", langCode: "yo" })
  })

  it("gives a second lane of the same language the opaque id as its tag", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "Yoruba Team",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: [...spanishDefault, { id: "yo1", name: "Yoruba", legacyTag: "Yoruba" }],
    })
    expect(plan).toMatchObject({ ok: true, name: "Yoruba Team", legacyTag: "aabbccdd", langCode: "yo" })
  })

  it("does not reuse the default language string as a second lane's tag", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "Spanish Team",
      language: "Spanish",
      targetLanguage: "Spanish",
      existing: spanishDefault,
    })
    expect(plan).toMatchObject({ ok: true, legacyTag: "aabbccdd", langCode: "es" })
  })

  it("refuses a duplicate display name", () => {
    const plan = planNewTargetLane({
      laneId: "aabbccdd",
      name: "yoruba",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: [...spanishDefault, { id: "yo1", name: "Yoruba", legacyTag: "Yoruba" }],
    })
    expect(plan).toEqual({ ok: false, problem: "duplicate" })
  })
})
