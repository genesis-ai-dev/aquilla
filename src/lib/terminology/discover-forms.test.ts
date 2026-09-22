import { describe, it, expect } from "vitest"
import { countConceptOccurrences, discoverForms } from "./discover-forms"

const cells = [
  { id: "c1", original: "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָֽרֶץ׃" },
  { id: "c2", original: "וְהָאָ֗רֶץ הָיְתָה תֹ֙הוּ֙ וָבֹ֔הוּ" },
  { id: "c3", original: "וַיִּקְרָ֨א אֱלֹהִ֤ים ׀ לַיַּבָּשָׁה֙ אֶ֔רֶץ" },
  { id: "c4", original: "וְהָאָרֶץ again" },
]
const project = { prefixes: ["ו", "ה", "ב"], suffixes: [] }
const concept = { sourceTerm: "הָאָ֗רֶץ" }

describe("discoverForms", () => {
  // WHY: this list IS the UX. The user learns what "matching" means by seeing
  // the forms it caught, grouped by surface string, most common first.
  // Controller ruling: with every count tied at 1, ordering falls to
  // localeCompare, so asserting an exact sorted array is brittle — compare
  // the surfaces as a set and assert the counts separately instead.
  it("groups matched surface forms with counts, most frequent first", () => {
    const forms = discoverForms(cells, concept, project)
    expect(new Set(forms.map((f) => f.surface))).toEqual(
      new Set(["וְהָאָ֗רֶץ", "וְהָאָרֶץ", "הָאָֽרֶץ"]),
    )
    expect(forms.every((f) => f.count === 1)).toBe(true)
    expect(forms.every((f) => f.sampleCellIds.length === 1)).toBe(true)
  })

  // WHY: an excluded form must still be listed (flagged) so it can be
  // re-included from the same chip.
  it("flags excluded forms instead of hiding them", () => {
    const forms = discoverForms(cells, { ...concept, match: { excludedForms: ["וְהָאָ֗רֶץ"] } }, project)
    const ex = forms.filter((f) => f.excluded).map((f) => f.surface).sort()
    // Folded comparison: both וְהָאָ֗רֶץ and וְהָאָרֶץ fold to והארץ.
    expect(ex).toEqual(["וְהָאָ֗רֶץ", "וְהָאָרֶץ"].sort())
    expect(forms.find((f) => f.surface === "הָאָֽרֶץ")?.excluded).toBe(false)
  })

  // WHY: the popover's "matches N places" is a cell count, not a hit count,
  // and must not count cells whose only hits are excluded.
  it("countConceptOccurrences counts cells with a live match", () => {
    expect(countConceptOccurrences(cells, concept, project)).toBe(3)
    expect(countConceptOccurrences(cells, { ...concept, match: { excludedForms: ["והארץ"] } }, project)).toBe(1)
  })
})
