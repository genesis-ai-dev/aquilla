import { describe, it, expect } from "vitest"
import { hasCombiningMarks, pruneMatch, resolveMatchOptions, coerceMatchOptions } from "./match-options"

describe("resolveMatchOptions", () => {
  // WHY: the whole point of script-derived defaults is that a user who selects
  // pointed Hebrew gets mark-tolerant matching without finding a checkbox.
  it("folds marks by default when the term carries combining marks", () => {
    expect(resolveMatchOptions({ sourceTerm: "הָאָ֗רֶץ" }).foldMarks).toBe(true)
    expect(resolveMatchOptions({ sourceTerm: "grace" }).foldMarks).toBe(false)
  })

  // WHY: Latin diacritics (é, ñ) are letters that matter; folding must not
  // silently turn on for them. NFD splits é into e + mark, so we check the
  // NFC-composed form first and only look at marks that survive composition.
  it("does not treat precomposed Latin diacritics as combining marks", () => {
    expect(hasCombiningMarks("café")).toBe(false)
    expect(hasCombiningMarks("Español")).toBe(false)
    expect(hasCombiningMarks("בְּרֵאשִׁית")).toBe(true)
  })

  // WHY: an explicit per-concept choice must beat every default.
  it("explicit concept options win over defaults", () => {
    expect(resolveMatchOptions({ sourceTerm: "הָאָ֗רֶץ", match: { foldMarks: false } }).foldMarks).toBe(false)
    expect(resolveMatchOptions({ sourceTerm: "grace", match: { foldMarks: true } }).foldMarks).toBe(true)
  })

  // WHY: the project-level default is the admin's override for a whole
  // termbase; it sits between the script default and the per-concept choice.
  it("project foldMarksDefault beats the script default but not the concept", () => {
    const project = { prefixes: [], suffixes: [], foldMarksDefault: true }
    expect(resolveMatchOptions({ sourceTerm: "grace" }, project).foldMarks).toBe(true)
    expect(resolveMatchOptions({ sourceTerm: "grace", match: { foldMarks: false } }, project).foldMarks).toBe(false)
  })

  // WHY: affixes default on only when there is an inventory to apply; with an
  // empty inventory the flag is meaningless and must resolve false so the
  // regex builder never emits an empty alternation.
  it("affixes default to whether the project has an inventory", () => {
    expect(resolveMatchOptions({ sourceTerm: "x" }).affixes).toBe(false)
    expect(resolveMatchOptions({ sourceTerm: "x" }, { prefixes: ["ו"], suffixes: [] }).affixes).toBe(true)
    expect(resolveMatchOptions({ sourceTerm: "x", match: { affixes: false } }, { prefixes: ["ו"], suffixes: [] }).affixes).toBe(false)
  })

  // WHY: consumers iterate these; they must never be undefined.
  it("always returns arrays and a numeric maxAffixes", () => {
    const r = resolveMatchOptions({ sourceTerm: "x" })
    expect(r.forms).toEqual([])
    expect(r.excludedForms).toEqual([])
    expect(r.prefixes).toEqual([])
    expect(r.suffixes).toEqual([])
    expect(r.maxAffixes).toBe(2)
  })
})

describe("pruneMatch", () => {
  // WHY: the add-concept form always carries a `match` object, so without
  // pruning every new concept would persist empty arrays and undefined keys —
  // making a term that took every default look like one whose owner had
  // deliberately overridden the matcher.
  it("drops empty values and returns undefined when nothing was set", () => {
    expect(pruneMatch(undefined)).toBeUndefined()
    expect(pruneMatch({})).toBeUndefined()
    expect(pruneMatch({ forms: [], excludedForms: [] })).toBeUndefined()
    expect(pruneMatch({ foldMarks: false, forms: [], excludedForms: ["x"] })).toEqual({
      foldMarks: false,
      excludedForms: ["x"],
    })
  })
})

describe("coerceMatchOptions", () => {
  // WHY: match options can arrive from a hand-written or third-party TBX note,
  // where nothing enforces the field types. resolveMatchOptions calls .map on
  // forms/excludedForms, so a string there would throw at MATCH time — long
  // after the import that accepted it, with no way to tell which concept is
  // poisoned. Bad fields must be dropped at the door instead.
  it("drops fields whose type is wrong instead of trusting them", () => {
    expect(coerceMatchOptions({ forms: "אֶרֶץ" })).toBeUndefined()
    expect(coerceMatchOptions({ foldMarks: "yes" })).toBeUndefined()
    expect(coerceMatchOptions({ forms: ["a", 3, null, "b"] })).toEqual({ forms: ["a", "b"] })
    expect(coerceMatchOptions({ foldMarks: "yes", affixes: false })).toEqual({ affixes: false })
  })

  // WHY: unknown keys would otherwise be persisted onto Concept.match forever,
  // and every later reader would have to defend against them.
  it("keeps only the known keys", () => {
    expect(coerceMatchOptions({ foldMarks: true, maxAffixes: 9, junk: "x" })).toEqual({
      foldMarks: true,
    })
  })

  // WHY: a non-object note carries no options at all; callers rely on
  // undefined to mean "leave concept.match unset" rather than storing {}.
  it("returns undefined for non-objects and for an empty result", () => {
    expect(coerceMatchOptions(null)).toBeUndefined()
    expect(coerceMatchOptions(["forms"])).toBeUndefined()
    expect(coerceMatchOptions("forms")).toBeUndefined()
    expect(coerceMatchOptions({})).toBeUndefined()
    expect(coerceMatchOptions({ forms: [] })).toBeUndefined()
  })
})
