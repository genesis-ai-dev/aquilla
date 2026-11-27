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
import { CATALOGS } from "./messages/all"
import type { Catalog, MessageKey } from "./messages/en"
// Read as text, not as JSON modules: an `import x from "./x.json"` makes `tsc -b`
// type every key, and source-hashes.json alone (~129k lines) took the app
// project past Node's default heap in the Workers preview build.
import sourceHashesRaw from "./source-hashes.json?raw"
import committedBaselineRaw from "./translation-baseline.json?raw"

const sourceHashes = JSON.parse(sourceHashesRaw) as Record<string, SourceHashes>
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

// The gate itself, against the real catalogs. `pnpm i18n:check` runs the same
// comparison in CI's lint job and prints the fix; this keeps `pnpm test` honest.
describe("committed catalogs against translation-baseline.json", () => {
  const gaps = allLocaleGaps(CATALOGS, sourceHashes)
  const baseline = committedBaseline

  it("translates every English message outside the baseline in every locale", () => {
    const violations = coverageViolations(gaps, baseline).map((v) => `${v.locale}: ${v.key} (${v.kind})`)
    expect(
      violations,
      "New or reworded English must ship translated. Run pnpm i18n:todo --new, fill " +
        "i18n-todo/<locale>.todo.json, then pnpm i18n:import-todo (docs/I18N-CONTEXT-CATALOG.md).",
    ).toEqual([])
  })

  it("has no baseline entry that is already translated or no longer exists", () => {
    const stale = unprunedEntries(gaps, baseline).map(({ key, locale }) => `${locale}: ${key}`)
    expect(stale, "Run pnpm i18n:baseline to prune these entries.").toEqual([])
  })

  it("is in its canonical one-key-per-line form", () => {
    expect(renderBaseline(baseline)).toBe(renderBaseline(JSON.parse(JSON.stringify(baseline))))
    expect(Object.keys(baseline)).toEqual([...Object.keys(baseline)].sort())
  })
})
