// AQU-1691 — the Language profile card's drafts.
//
// WHY: a person types lists and pairs ("ne, pas", "12 = twelve"); checks and
// drafting read structured slots. Each conversion must round-trip what is
// stored, must store nothing for a question left "not set", and must produce a
// value the slot's own validator accepts — or one it rejects, so the card
// reports the problem instead of storing something half-right.

import { describe, expect, it } from "vitest"
import { languageProfileSlotProblem } from "../../../db/shared/language-profile"
import {
  divineNamesDraft,
  divineNamesValue,
  kinTermsDraft,
  kinTermsValue,
  numberWordsDraft,
  numberWordsValue,
  pronounsDraft,
  pronounsValue,
  questionMarkersDraft,
  questionMarkersValue,
  splitList,
} from "./language-profile-drafts"

describe("splitList", () => {
  it("splits on commas in several scripts, semicolons and lines, and drops blanks and repeats", () => {
    expect(splitList(" ne, pas ;jamais\nrien,, ne")).toEqual(["ne", "pas", "jamais", "rien"])
    expect(splitList("لا، لم")).toEqual(["لا", "لم"])
    expect(splitList("不、没")).toEqual(["不", "没"])
  })
})

describe("round trips", () => {
  it.each([
    ["questionMarkers", { particles: ["吗"], suffix: ["ko"] }, questionMarkersDraft, questionMarkersValue],
    [
      "pronouns",
      {
        secondPerson: { numberDistinction: true, singular: ["yu"], plural: ["yupela"] },
        firstPersonPlural: { clusivity: true, inclusive: ["yumi"], exclusive: ["mipela"] },
        extraNumbers: { dual: true, dualForms: ["yutupela"] },
        thirdPerson: { genderOrClass: false },
        honorifics: { levels: [{ name: "Familiar", forms: ["tu"] }, { name: "Royal" }] },
      },
      pronounsDraft,
      pronounsValue,
    ],
    ["numberWords", { "1": "one", "12": "twelve" }, numberWordsDraft, numberWordsValue],
    ["numberWords", "cldr", numberWordsDraft, numberWordsValue],
    ["kinTerms", { relativeAgeDistinction: true, notes: "kakak / adik" }, kinTermsDraft, kinTermsValue],
    [
      "divineNames",
      { yhwh: "the LORD", kyriosGod: "the Lord", kyriosJesus: "Lord", deityPronounCapitalization: false },
      divineNamesDraft,
      divineNamesValue,
    ],
  ] as const)("%s: stored → draft → stored is unchanged, and valid", (slot, stored, toDraft, toValue) => {
    const value = (toValue as (draft: unknown) => unknown)((toDraft as (held: unknown) => unknown)(stored))
    expect(value).toEqual(stored)
    expect(languageProfileSlotProblem(slot, value)).toBeNull()
  })
})

describe("what a draft stores", () => {
  it("stores an empty question-markers slot, which means a question mark only", () => {
    expect(questionMarkersValue({ particles: "", suffix: " " })).toEqual({})
    expect(languageProfileSlotProblem("questionMarkers", {})).toBeNull()
  })

  it("stores nothing for a pronoun question left not set, and no forms for a 'no'", () => {
    const draft = { ...pronounsDraft(undefined), firstPersonPlural: "no" as const, inclusive: "yumi" }
    expect(pronounsValue(draft)).toEqual({ firstPersonPlural: { clusivity: false } })
  })

  it("leaves an untouched pronoun inventory empty, which the slot refuses rather than storing nothing", () => {
    expect(languageProfileSlotProblem("pronouns", pronounsValue(pronounsDraft(undefined)))).toMatch(/at least one part/)
  })

  it("keeps a malformed number line so validation can name it", () => {
    const value = numberWordsValue({ mode: "explicit", words: "12 = twelve\ntwelve = 12" })
    expect(languageProfileSlotProblem("numberWords", value)).toMatch(/not a whole number/)
    expect(numberWordsValue({ mode: "unset", words: "" })).toBeNull()
  })

  it("waits for the kin-term question before it stores anything", () => {
    expect(kinTermsValue({ relativeAge: "unset", notes: "kakak" })).toBeNull()
    expect(kinTermsValue({ relativeAge: "no", notes: " " })).toEqual({ relativeAgeDistinction: false })
  })
})
