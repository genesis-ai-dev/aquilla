import { describe, it, expect } from "vitest"
import {
  DEFAULT_PLURAL_VAR,
  isPluralMessage,
  plural,
  pluralCategoriesFor,
  pluralCategory,
  pluralCountFrom,
  selectPluralForm,
} from "./plurals"
import { translate } from "./translate"
import { en } from "./messages/en"

/**
 * Why these tests are shaped this way.
 *
 * The defect this mechanism replaces was a *design* defect: two-form keys picked
 * with `count === 1`. Every such key renders correctly in English for 1 and for
 * 2, so a test that only checks English 1-vs-2 passes on the broken design and
 * proves nothing. What has to be pinned down instead is the behaviour English
 * cannot exhibit at all:
 *
 *   - Arabic selects a category English never has, for a count English treats as
 *     plain plural;
 *   - Thai and Burmese supply only `other` and must still render;
 *   - a locale missing the category selected for this count must fall back to
 *     real text, never to a raw key.
 *
 * Break any of those and Arabic ships ungrammatical, which is the whole reason
 * the catalog was re-keyed before translators saw it.
 */

const ONE_TO_MANY = plural({ one: "{count} result", other: "{count} results" })

describe("pluralCategory", () => {
  it("selects a different category for Arabic than for English at the same count", () => {
    // 2 is "other" in English and "two" in Arabic; 3 is "other" in English and
    // "few" in Arabic. A two-form key cannot express either, which is why the
    // old shape had a correctness ceiling rather than a quality problem.
    expect(pluralCategory("en", 2)).toBe("other")
    expect(pluralCategory("ar", 2)).toBe("two")
    expect(pluralCategory("en", 3)).toBe("other")
    expect(pluralCategory("ar", 3)).toBe("few")
    expect(pluralCategory("ar", 0)).toBe("zero")
    expect(pluralCategory("ar", 11)).toBe("many")
  })

  it("collapses every count to `other` for languages with one form", () => {
    for (const count of [0, 1, 2, 3, 11, 100]) {
      expect(pluralCategory("th", count), `th ${count}`).toBe("other")
      expect(pluralCategory("my", count), `my ${count}`).toBe("other")
      // `Intl.PluralRules` does not know `mfa` and silently falls back to the
      // runtime default, so the override table is what keeps Patani Malay from
      // being asked for an unusable `one` form.
      expect(pluralCategory("mfa", count), `mfa ${count}`).toBe("other")
    }
  })

  it("degrades a malformed locale or a non-finite count to a renderable form", () => {
    expect(pluralCategory("not a locale", 1)).toBe("one")
    expect(pluralCategory("en", Number.NaN)).toBe("other")
  })
})

describe("pluralCategoriesFor", () => {
  it("reports the category set each shipping locale must fill", () => {
    expect(pluralCategoriesFor("en")).toEqual(["one", "other"])
    expect(pluralCategoriesFor("ar")).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ])
    expect(pluralCategoriesFor("th")).toEqual(["other"])
    expect(pluralCategoriesFor("my")).toEqual(["other"])
    expect(pluralCategoriesFor("mfa")).toEqual(["other"])
  })
})

describe("pluralCountFrom", () => {
  it("reads the governing number, including counts already formatted for display", () => {
    expect(pluralCountFrom({ count: 3 }, DEFAULT_PLURAL_VAR)).toBe(3)
    // Several call sites hand `t()` a grouped count because the separators
    // belong in the rendered string; selection still needs the magnitude.
    expect(pluralCountFrom({ count: "1,234" }, DEFAULT_PLURAL_VAR)).toBe(1234)
    expect(pluralCountFrom({ total: 1 }, "total")).toBe(1)
    expect(pluralCountFrom({ count: "—" }, DEFAULT_PLURAL_VAR)).toBeUndefined()
    expect(pluralCountFrom(undefined, DEFAULT_PLURAL_VAR)).toBeUndefined()
  })
})

describe("selectPluralForm", () => {
  it("uses a single-form locale's `other` for every count", () => {
    const th = plural({ other: "{count} ผลลัพธ์" })
    for (const count of [0, 1, 2, 5]) {
      expect(selectPluralForm(th, ONE_TO_MANY, "th", { count })).toBe("{count} ผลลัพธ์")
    }
  })

  it("falls back to the locale's `other` when the selected category is missing", () => {
    // A real, expected state: a translator filled Arabic's `other` and `one` but
    // not `few`. Rendering must stay in the target language, not switch to
    // English mid-sentence and certainly not print the key.
    const partialAr = plural({ one: "نتيجة واحدة", other: "{count} نتيجة" })
    expect(selectPluralForm(partialAr, ONE_TO_MANY, "ar", { count: 3 })).toBe(
      "{count} نتيجة",
    )
    expect(selectPluralForm(partialAr, ONE_TO_MANY, "ar", { count: 1 })).toBe(
      "نتيجة واحدة",
    )
  })

  it("falls back to English text, never a raw key, when the locale has nothing", () => {
    expect(selectPluralForm(undefined, ONE_TO_MANY, "ar", { count: 3 })).toBe(
      "{count} results",
    )
    expect(selectPluralForm(plural({}), ONE_TO_MANY, "ar", { count: 3 })).toBe(
      "{count} results",
    )
  })

  it("treats a locale that supplied one plain string as its `other` form", () => {
    expect(selectPluralForm("{count} ผลลัพธ์", ONE_TO_MANY, "th", { count: 2 })).toBe(
      "{count} ผลลัพธ์",
    )
  })

  it("resolves to `other` when no count was passed at all", () => {
    expect(selectPluralForm(undefined, ONE_TO_MANY, "en", undefined)).toBe(
      "{count} results",
    )
  })
})

describe("isPluralMessage", () => {
  it("distinguishes count-governed values from plain strings", () => {
    expect(isPluralMessage("Save")).toBe(false)
    expect(isPluralMessage(undefined)).toBe(false)
    expect(isPluralMessage(ONE_TO_MANY)).toBe(true)
  })
})

describe("translate over a count-governed key", () => {
  // Pick a real catalog key rather than a fixture, so this goes red if the
  // migration ever regresses a key back to a hand-picked two-form pair.
  const key = "search.resultCount" as const

  it("renders English's own two forms", () => {
    expect(translate(undefined, key, { count: 1 })).toBe("1 result")
    expect(translate(undefined, key, { count: 2 })).toBe("2 results")
  })

  it("uses the Arabic-specific form for a count English calls plain plural", () => {
    const ar = {
      [key]: plural({
        zero: "لا نتائج",
        one: "نتيجة واحدة",
        two: "نتيجتان",
        few: "{count} نتائج",
        many: "{count} نتيجة",
        other: "{count} نتيجة",
      }),
    }
    expect(translate(ar, key, { count: 2 }, "ar")).toBe("نتيجتان")
    expect(translate(ar, key, { count: 3 }, "ar")).toBe("3 نتائج")
    expect(translate(ar, key, { count: 0 }, "ar")).toBe("لا نتائج")
  })

  it("renders a one-form locale for every count", () => {
    const th = { [key]: plural({ other: "{count} ผลลัพธ์" }) }
    expect(translate(th, key, { count: 1 }, "th")).toBe("1 ผลลัพธ์")
    expect(translate(th, key, { count: 7 }, "th")).toBe("7 ผลลัพธ์")
  })

  it("never renders a raw key for any base key, at any count, in any locale", () => {
    for (const locale of ["en", "th", "my", "mfa", "ar"]) {
      for (const k of Object.keys(en) as (keyof typeof en)[]) {
        for (const count of [0, 1, 2, 3, 11]) {
          const out = translate({}, k, { count, total: count }, locale)
          expect(out, `${k} @ ${locale} ${count}`).not.toBe(k)
          expect(out.length, `${k} @ ${locale} ${count}`).toBeGreaterThan(0)
        }
      }
    }
  })
})
