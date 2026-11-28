import { describe, expect, it } from "vitest"
import {
  allLocaleGaps,
  allowInBaseline,
  baselineFromGaps,
  coverageViolations,
  localeGaps,
  pruneBaseline,
  renderBaseline,
  unprunedEntries,
  type TranslationBaseline,
} from "./coverage"
import type { SourceHashes } from "./catalog-export"
import type { Catalog, MessageKey } from "./messages/en"
// Read as text, not as a JSON module: an `import x from "./x.json"` makes
// `tsc -b` type every key.
import committedBaselineRaw from "./translation-baseline.json?raw"

const committedBaseline = JSON.parse(committedBaselineRaw) as TranslationBaseline

// Three made-up keys and a hash function that is just the key's current
// "English", so a test states staleness directly instead of computing sha256.
const KEYS = ["a.one", "a.two", "a.three"] as unknown as MessageKey[]
const english: Record<string, string> = { "a.one": "One", "a.two": "Two", "a.three": "Three" }
const hashOf = (key: MessageKey) => english[key]
const cat = (entries: Record<string, string>) => entries as unknown as Catalog
const hashes = (entries: Record<string, string>) => entries as unknown as SourceHashes

describe("localeGaps", () => {
  it("reports a missing key as untranslated", () => {
    const gaps = localeGaps(cat({ "a.one": "Uno", "a.two": "Dos" }), {}, KEYS, hashOf)
    expect([...gaps]).toEqual([["a.three", "untranslated"]])
  })

  it("reports a translation made against older English as stale", () => {
    const gaps = localeGaps(
      cat({ "a.one": "Uno", "a.two": "Dos", "a.three": "Tres" }),
      hashes({ "a.one": "One", "a.two": "Two (old wording)" }),
      KEYS,
      hashOf,
    )
    expect([...gaps]).toEqual([["a.two", "stale"]])
  })

  it("does not call a translation with no recorded hash stale", () => {
    const gaps = localeGaps(cat({ "a.one": "Uno", "a.two": "Dos", "a.three": "Tres" }), {}, KEYS, hashOf)
    expect(gaps.size).toBe(0)
  })
})

describe("allLocaleGaps", () => {
  it("skips English, the source every other locale falls back to", () => {
    const gaps = allLocaleGaps({ en: cat({}), es: cat({}) }, {}, KEYS, hashOf)
    expect([...gaps.keys()]).toEqual(["es"])
  })
})

describe("the ratchet", () => {
  const gaps = allLocaleGaps(
    { es: cat({ "a.one": "Uno" }), fr: cat({ "a.one": "Un", "a.two": "Deux" }) },
    {},
    KEYS,
    hashOf,
  )

  it("lets the baseline's gaps through and fails every other one", () => {
    const baseline: TranslationBaseline = { "a.two": ["es"], "a.three": ["es", "fr"] }
    expect(coverageViolations(gaps, baseline)).toEqual([])

    // A branch adds `a.three` to English and translates it nowhere.
    const without: TranslationBaseline = { "a.two": ["es"] }
    expect(coverageViolations(gaps, without)).toEqual([
      { locale: "es", key: "a.three", kind: "untranslated" },
      { locale: "fr", key: "a.three", kind: "untranslated" },
    ])
  })

  it("flags baseline entries that are no longer gaps, so the baseline only shrinks", () => {
    const baseline: TranslationBaseline = {
      "a.two": ["es", "fr"], // fr has been translated since
      "a.gone": ["es"], // removed from English
    }
    expect(unprunedEntries(gaps, baseline)).toEqual([
      { key: "a.two", locale: "fr" },
      { key: "a.gone", locale: "es" },
    ])
  })

  it("prunes only what is no longer a gap, and never adds", () => {
    const baseline: TranslationBaseline = { "a.two": ["es", "fr"], "a.gone": ["es"] }
    // `a.three` is a gap the baseline does not allow: pruning must not let it in.
    expect(pruneBaseline(baseline, gaps)).toEqual({ "a.two": ["es"] })
  })

  it("prunes a single locale without touching the others", () => {
    const baseline: TranslationBaseline = { "a.one": ["es", "fr"] }
    // An import into es filled a.one. fr's entry is not this import's to judge.
    const esOnly = new Map([["es", localeGaps(cat({ "a.one": "Uno" }), {}, KEYS, hashOf)]])
    expect(pruneBaseline(baseline, esOnly, "es")).toEqual({ "a.one": ["fr"] })
  })

  it("rebuilds to exactly the current gaps", () => {
    expect(baselineFromGaps(gaps)).toEqual({ "a.three": ["es", "fr"], "a.two": ["es"] })
  })

  it("allows a key only where it is actually a gap", () => {
    expect(allowInBaseline({}, gaps, ["a.two"])).toEqual({ "a.two": ["es"] })
    expect(allowInBaseline({}, gaps, ["a.three"], ["fr"])).toEqual({ "a.three": ["fr"] })
  })
})

describe("renderBaseline", () => {
  it("writes one sorted key per line and round-trips as JSON", () => {
    const text = renderBaseline({ "b.key": ["fr", "es", "fr"], "a.key": ["th"], "c.empty": [] })
    expect(text).toBe('{\n  "a.key": ["th"],\n  "b.key": ["es","fr"]\n}\n')
    expect(JSON.parse(text)).toEqual({ "a.key": ["th"], "b.key": ["es", "fr"] })
    expect(renderBaseline({})).toBe("{}\n")
  })
})

// Whether the committed catalogs are fully translated is not asserted here
// (AQU-2792). It was, and a pull request that merged without its translations
// then failed this file on every other open pull request. `pnpm i18n:coverage`
// makes the comparison, and the fill job runs it after translating
// (.github/workflows/i18n-fill.yml). What a branch can still get wrong by hand
// is the file's shape.
describe("the committed translation-baseline.json", () => {
  const baseline = committedBaseline

  it("is in its canonical one-key-per-line form", () => {
    expect(renderBaseline(baseline)).toBe(renderBaseline(JSON.parse(JSON.stringify(baseline))))
    expect(Object.keys(baseline)).toEqual([...Object.keys(baseline)].sort())
  })
})
