import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { extractJsonStrings, exportJson } from "@/lib/parsers/json-i18n"
import {
  CATALOG_SOURCE_ROOT,
  buildCatalogSourceDocument,
  catalogLeafKeys,
  parseLeafKey,
  buildCatalogSourceJson,
  buildContextSidecarJson,
  catalogJsonPath,
  contextNote,
  importCatalog,
  mergeCatalogs,
  messageKeyForPath,
  parseTranslatedCatalog,
  renderCatalogModule,
  sourceHash,
  type SourceHashes,
} from "./catalog-export"
import {
  MESSAGE_KEYS,
  englishSourceFor,
  namespaceOf,
  pluralMessageFor,
} from "./context"
import { type Catalog, type MessageKey } from "./messages/en"
import { isPluralMessage, type PluralCategory } from "./plurals"
import { translate } from "./translate"

// ─── pseudo-translation ──────────────────────────────────────────────────────

const ACCENTS: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú" }

/**
 * Deterministic pseudolocalization: accent the vowels and bracket the string,
 * leaving `{placeholder}` spans untouched. Standing in for a human translator
 * keeps this test honest — it exercises the entire pipeline, including
 * placeholder preservation and non-ASCII round-tripping, without shipping
 * invented translations for a language nobody here can check.
 */
function pseudo(source: string): string {
  const body = source
    .split(/(\{\w+\})/g)
    .map((part) =>
      part.startsWith("{") ? part : part.replace(/[aeiou]/g, (c) => ACCENTS[c]),
    )
    .join("")
  return `⟦${body}⟧`
}

function makeCell(original: string, translated: string, context: string): CellData {
  return {
    id: `cell-${context}`,
    fileId: "en-catalog",
    original,
    translated,
    context,
    group: context,
    type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

// ─── source document ─────────────────────────────────────────────────────────

describe("catalog source document", () => {
  it("contains every leaf with its English value", () => {
    const doc = buildCatalogSourceDocument()
    expect(Object.keys(doc[CATALOG_SOURCE_ROOT])).toEqual(catalogLeafKeys())
    for (const leaf of catalogLeafKeys()) {
      const { key, category } = parseLeafKey(leaf)
      const forms = pluralMessageFor(key as MessageKey)
      const expected =
        forms && category
          ? (forms.forms[category] ?? forms.forms.other)
          : englishSourceFor(key as MessageKey)
      expect(doc[CATALOG_SOURCE_ROOT][leaf], leaf).toBe(expected)
    }
  })

  it("gives a locale one leaf per plural category its language needs", () => {
    // The whole point of the leaf encoding: an Arabic translator must be handed
    // six cells for a counted message, and a Thai translator one. Exporting
    // English's two forms to both would make Arabic impossible to get right and
    // waste four fifths of the Thai work.
    const pluralKey = MESSAGE_KEYS.find((k) => pluralMessageFor(k))
    expect(pluralKey, "the catalog has no count-governed keys to check").toBeDefined()
    const leavesFor = (locale: string) =>
      Object.keys(buildCatalogSourceDocument(locale)[CATALOG_SOURCE_ROOT]).filter(
        (leaf) => parseLeafKey(leaf).key === pluralKey,
      )
    expect(leavesFor("ar")).toHaveLength(6)
    expect(leavesFor("th")).toEqual([`${pluralKey}#other`])
    expect(leavesFor("en").sort()).toEqual([`${pluralKey}#one`, `${pluralKey}#other`])
  })

  it("serializes deterministically, so regenerating produces no diff", () => {
    expect(buildCatalogSourceJson()).toBe(buildCatalogSourceJson())
    expect(buildCatalogSourceJson().endsWith("\n")).toBe(true)
  })
})

describe("JSON path mapping", () => {
  it("agrees with the paths the json-i18n parser actually emits", () => {
    // The load-bearing contract: keyed export matches cells to leaves by this
    // path, so a drift here silently stops translations from being applied.
    const emitted = extractJsonStrings(buildCatalogSourceJson()).map((s) => s.context)
    expect(emitted).toEqual(catalogLeafKeys().map((leaf) => catalogJsonPath(leaf)))
  })

  it("round-trips leaf → path → leaf", () => {
    for (const leaf of catalogLeafKeys()) {
      expect(messageKeyForPath(catalogJsonPath(leaf))).toBe(leaf)
    }
  })

  it("returns undefined for a path that is not a catalog message", () => {
    expect(messageKeyForPath("other.thing")).toBeUndefined()
    expect(messageKeyForPath("messages")).toBeUndefined()
    expect(messageKeyForPath("")).toBeUndefined()
  })
})

// ─── context notes ───────────────────────────────────────────────────────────

describe("contextNote", () => {
  it("gives every key a standalone note naming its surface and behaviour", () => {
    for (const key of MESSAGE_KEYS) {
      const note = contextNote(key)
      expect(note, key).toMatch(/^Surface: .+/m)
      expect(note, key).toMatch(/^String: .+/m)
    }
  })

  it("includes the screenshot path and the surface's viewing notes", () => {
    const note = contextNote("nav.projects")
    expect(note).toContain("src/lib/i18n/screenshots/workspace-nav.png")
    expect(note).toContain("Workspace navigation")
    expect(note).toMatch(/In this screenshot:/)
  })

  it("tells a plural key's translator which form the cell is and what governs it", () => {
    const note = contextNote("search.resultCount", "ar", "few")
    // A translator handed one cell out of six needs to know (a) that the message
    // is count-governed at all, (b) how many forms their language wants, and
    // (c) which of them THIS cell is. Miss any of the three and the Arabic
    // catalog comes back unusable.
    expect(note).toMatch(/Plural: this message changes with the number in \{count\}/)
    expect(note).toMatch(/6 form\(s\): zero, one, two, few, many, other/)
    expect(note).toMatch(/This cell: the "few" form/)
    expect(note).toContain('one = "{count} result"')

    // Thai asks for one form, and says so in the same place.
    expect(contextNote("search.resultCount", "th", "other")).toMatch(/1 form\(s\): other/)
  })

  it("says nothing about plurals for a key that is not count-governed", () => {
    expect(contextNote("nav.projects")).not.toMatch(/^Plural:/m)
  })

  it("explains placeholders and length limits where they apply", () => {
    const note = contextNote("language.switchTo")
    expect(note).toMatch(/Placeholder \{language\}:/)

    expect(contextNote("nav.settings")).toMatch(/Length: aim for 24 characters/)
    // No artificial limit is claimed where the layout does not impose one.
    expect(contextNote("error.generic.title")).not.toMatch(/^Length:/m)
  })
})

describe("context sidecar", () => {
  it("emits versioned, parseable JSON in the documented shape", () => {
    const parsed = JSON.parse(buildContextSidecarJson()) as {
      version: number
      namespaces: Record<string, { _context: { description: string } }>
      plurals: Record<
        string,
        { countVar: string; categoriesByLocale: Record<string, string[]> }
      >
    }
    // v2 added the `plurals` section; a translator reading a v1 file would not
    // know their language needs categories English never wrote.
    expect(parsed.version).toBe(2)
    // Derived from the live catalog rather than hardcoded. The sidecar's job is
    // to carry EVERY namespace to translators, so what needs asserting is
    // "nothing was dropped in export" — not "these four exist". A literal list
    // here went red the moment the fan-out added namespaces, which said nothing
    // about whether the export was correct.
    expect(Object.keys(parsed.namespaces).sort()).toEqual(
      [...new Set(MESSAGE_KEYS.map((k) => namespaceOf(k)))].sort(),
    )
    expect(parsed.namespaces.nav._context.description).toMatch(/navigation/i)
  })

  it("tells a translator which plural categories their own language needs", () => {
    const parsed = JSON.parse(buildContextSidecarJson()) as {
      plurals: Record<
        string,
        { countVar: string; categoriesByLocale: Record<string, string[]> }
      >
    }
    const keys = Object.keys(parsed.plurals)
    expect(keys.length, "no count-governed keys reached the sidecar").toBeGreaterThan(0)
    const entry = parsed.plurals[keys[0]]
    expect(entry.countVar).toBe("count")
    // The whole reason this section exists: English's two forms say nothing
    // about Arabic's six, and a translator cannot guess the set.
    expect(entry.categoriesByLocale.ar).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ])
    expect(entry.categoriesByLocale.th).toEqual(["other"])
    expect(entry.categoriesByLocale.my).toEqual(["other"])
    expect(entry.categoriesByLocale.mfa).toEqual(["other"])
  })
})

// ─── the loop ────────────────────────────────────────────────────────────────

describe("catalog round-trip through an Aquilla project (AQU-832)", () => {
  it("survives export → import → translate → export → catalog", async () => {
    // 1. Export the en catalog as a JSON source file.
    const source = buildCatalogSourceJson()

    // 2. Import it the way the app does — one cell per message key, each
    //    carrying its AQU-832 context note.
    const strings = extractJsonStrings(source)
    expect(strings).toHaveLength(catalogLeafKeys().length)

    const cells = strings.map((s) => {
      const leaf = messageKeyForPath(s.context)
      expect(leaf, `cell ${s.context} did not map back to a message key`).toBeDefined()
      // Every imported cell has translator-facing context, not a bare path.
      const key = parseLeafKey(leaf as string).key as MessageKey
      expect(contextNote(key).length).toBeGreaterThan(0)
      // 3. Translate.
      return makeCell(s.original, pseudo(s.original), s.context)
    })

    // 4. Export back out of the project and parse into a catalog.
    const translatedJson = await exportJson(source, cells, { keyed: true }).text()
    const { catalog, unknownKeys, missingKeys } = parseTranslatedCatalog(translatedJson)

    expect(unknownKeys).toEqual([])
    expect(missingKeys).toEqual([])
    for (const key of MESSAGE_KEYS) {
      const forms = pluralMessageFor(key)
      if (forms) {
        // A count-governed key round-trips as one cell per plural category, so
        // what must survive is every form — not a single string.
        const translated = catalog[key]
        expect(isPluralMessage(translated), key).toBe(true)
        if (!isPluralMessage(translated)) continue
        for (const [category, english] of Object.entries(forms.forms)) {
          expect(translated.forms[category as PluralCategory], `${key}#${category}`).toBe(
            pseudo(english),
          )
        }
        continue
      }
      expect(catalog[key], key).toBe(pseudo(englishSourceFor(key)))
    }
  })

  it("keeps placeholders intact and interpolable after the round-trip", async () => {
    const source = buildCatalogSourceJson()
    const cells = extractJsonStrings(source).map((s) =>
      makeCell(s.original, pseudo(s.original), s.context),
    )
    const { catalog } = parseTranslatedCatalog(
      await exportJson(source, cells, { keyed: true }).text(),
    )

    // `translate` is exactly what I18nProvider's `t` calls.
    expect(translate(catalog, "language.switchTo", { language: "ไทย" })).toBe(
      "⟦Swítch lángúágé tó ไทย⟧",
    )
  })

  it("treats a cell the translator skipped as missing, not as a translation", async () => {
    const source = buildCatalogSourceJson()
    // `exportJson` falls back to `cell.original` for an empty translation, so an
    // untouched cell comes back as the English string — that must not be
    // recorded as a translation, or the locale would look complete when it isn't.
    const cells = extractJsonStrings(source).map((s) =>
      makeCell(s.original, s.context.includes("nav.") ? pseudo(s.original) : "", s.context),
    )
    const { catalog, missingKeys } = parseTranslatedCatalog(
      await exportJson(source, cells, { keyed: true }).text(),
    )

    expect(catalog["nav.projects"]).toBe(pseudo(englishSourceFor("nav.projects")))
    expect(catalog["common.save"]).toBeUndefined()
    expect(missingKeys).toContain("common.save")
    expect(missingKeys).not.toContain("nav.projects")

    // A partial catalog is still safe to ship: untranslated keys fall back to
    // real English, never to a raw key.
    expect(translate(catalog, "common.save")).toBe("Save")
  })

  it("reports keys that no longer exist in the base catalog instead of throwing", () => {
    const doc = buildCatalogSourceDocument()
    doc[CATALOG_SOURCE_ROOT]["nav.retired"] = "Retired"
    const { catalog, unknownKeys } = parseTranslatedCatalog(JSON.stringify(doc))
    expect(unknownKeys).toEqual(["nav.retired"])
    expect(Object.keys(catalog)).not.toContain("nav.retired")
  })

  it("rejects a file that is not a catalog export", () => {
    expect(() => parseTranslatedCatalog("{}")).toThrow(/missing its "messages" object/)
    expect(() => parseTranslatedCatalog("not json")).toThrow(/Invalid JSON/)
  })
})

// ─── shipping artifact ───────────────────────────────────────────────────────

describe("renderCatalogModule", () => {
  it("emits a module in base-catalog key order, omitting untranslated keys", () => {
    const module = renderCatalogModule("th", {
      "nav.settings": "การตั้งค่า",
      "nav.projects": "โครงการ",
    })
    expect(module).toContain('import type { Catalog } from "./en"')
    expect(module).toContain("export const th: Catalog = {")
    // Base-catalog order, not the object's insertion order — minimal diffs.
    expect(module.indexOf('"nav.projects"')).toBeLessThan(module.indexOf('"nav.settings"'))
    expect(module).not.toContain("common.save")
    expect(module.endsWith("}\n")).toBe(true)
  })

  it("emits a valid empty module for a locale with no translations yet", () => {
    expect(renderCatalogModule("my", {})).toContain("export const my: Catalog = {}")
  })

  it("escapes values so quotes and newlines cannot break the module", () => {
    const module = renderCatalogModule("ar", { "common.save": 'He said "no"\n' })
    expect(module).toContain('"common.save": "He said \\"no\\"\\n"')
  })
})

// ─── merge on import ─────────────────────────────────────────────────────────
//
// The regression these tests guard: `i18n-catalog.ts import` used to overwrite
// `messages/<locale>.ts` with ONLY the keys in the file just handed to it, so
// importing a file that carried just the newly-added keys silently destroyed
// every previously-translated key — while the CLI reported those destroyed
// keys as "Untranslated (safe to ship)". `mergeCatalogs` / `importCatalog` are
// the fix: merge by default, an explicit `--replace` for the real thing, and
// reporting driven by the merged result instead of the one file just imported.

describe("sourceHash", () => {
  it("is deterministic for the same key", () => {
    expect(sourceHash("common.save")).toBe(sourceHash("common.save"))
  })

  it("differs for keys with different English source", () => {
    expect(sourceHash("common.save")).not.toBe(sourceHash("common.cancel"))
  })
})

describe("mergeCatalogs", () => {
  it("keeps a key the existing catalog already translated when this import doesn't touch it", () => {
    const existing: Catalog = { "common.save": "บันทึก", "nav.projects": "โครงการ" }
    const incoming: Catalog = { "nav.settings": "การตั้งค่า" }
    const { catalog } = mergeCatalogs(existing, {}, incoming)
    expect(catalog["common.save"]).toBe("บันทึก")
    expect(catalog["nav.projects"]).toBe("โครงการ")
    expect(catalog["nav.settings"]).toBe("การตั้งค่า")
  })

  it("lets a fresh translation in this import override the existing one for the same key", () => {
    const existing: Catalog = { "common.save": "old" }
    const { catalog } = mergeCatalogs(existing, {}, { "common.save": "new" })
    expect(catalog["common.save"]).toBe("new")
  })

  it("produces a pure replacement when the caller passes an empty existing catalog (--replace)", () => {
    // This is exactly what the CLI does for `--replace`: it skips loading the
    // real existing catalog and hands mergeCatalogs {} instead. What must be
    // true is that nothing from before survives.
    const incoming: Catalog = { "nav.settings": "การตั้งค่า" }
    const { catalog } = mergeCatalogs({}, {}, incoming)
    expect(catalog).toEqual(incoming)
  })

  it("flags a carried-over translation stale when its recorded hash no longer matches its English source", () => {
    const existing: Catalog = { "common.save": "บันทึก" }
    // Stands in for "the English string changed after this was translated" —
    // the sidecar still has the hash of the OLD source.
    const staleHashes: SourceHashes = { "common.save": "0000000000000000" }
    const { catalog, staleKeys } = mergeCatalogs(existing, staleHashes, {})
    // Stale still ships — it is the best translation available — but it must
    // be reported, not silently trusted.
    expect(catalog["common.save"]).toBe("บันทึก")
    expect(staleKeys).toContain("common.save")
  })

  it("does not flag a translation stale when the recorded hash still matches its source", () => {
    const existing: Catalog = { "common.save": "บันทึก" }
    const currentHashes: SourceHashes = { "common.save": sourceHash("common.save") }
    const { staleKeys } = mergeCatalogs(existing, currentHashes, {})
    expect(staleKeys).not.toContain("common.save")
  })

  it("never flags a key retranslated in this import as stale, and refreshes its hash", () => {
    const existing: Catalog = { "common.save": "old" }
    const wrongHashes: SourceHashes = { "common.save": "0000000000000000" }
    const { staleKeys, hashes } = mergeCatalogs(existing, wrongHashes, {
      "common.save": "new",
    })
    expect(staleKeys).not.toContain("common.save")
    expect(hashes["common.save"]).toBe(sourceHash("common.save"))
  })

  it("does not flag a translation stale when no hash was ever recorded for it", () => {
    // Every catalog that shipped before this feature has no sidecar entry —
    // that must read as "unknown", not "stale everywhere".
    const existing: Catalog = { "common.save": "บันทึก" }
    const { staleKeys } = mergeCatalogs(existing, {}, {})
    expect(staleKeys).not.toContain("common.save")
  })
})

describe("importCatalog", () => {
  function translatedJson(entries: Record<string, string>): string {
    return JSON.stringify({ [CATALOG_SOURCE_ROOT]: entries })
  }

  it("preserves keys an earlier import already translated (the data-loss regression)", () => {
    const existing: Catalog = { "common.save": "บันทึก", "nav.projects": "โครงการ" }
    const outcome = importCatalog(
      translatedJson({ "nav.settings": "การตั้งค่า" }),
      existing,
      {},
    )
    expect(outcome.catalog["common.save"]).toBe("บันทึก")
    expect(outcome.catalog["nav.projects"]).toBe("โครงการ")
    expect(outcome.catalog["nav.settings"]).toBe("การตั้งค่า")
  })

  it("does not report a key preserved from an earlier import as untranslated", () => {
    // This is the misleading-report half of the bug: a key already translated,
    // merely absent from THIS file, used to print under "Untranslated (falls
    // back to English, safe to ship)" right after actually being destroyed.
    const existing: Catalog = { "common.save": "บันทึก" }
    const outcome = importCatalog(translatedJson({ "nav.settings": "การตั้งค่า" }), existing, {})
    expect(outcome.untranslatedKeys).not.toContain("common.save")
  })

  it("--replace discards keys not present in the imported file", () => {
    const existing: Catalog = { "common.save": "บันทึก" }
    const outcome = importCatalog(
      translatedJson({ "nav.settings": "การตั้งค่า" }),
      existing,
      {},
      { replace: true },
    )
    expect(outcome.catalog["common.save"]).toBeUndefined()
    expect(outcome.untranslatedKeys).toContain("common.save")
  })

  it("reports a key whose English source changed as stale, separately from untranslated", () => {
    const existing: Catalog = { "common.save": "บันทึก" }
    const staleHashes: SourceHashes = { "common.save": "0000000000000000" }
    const outcome = importCatalog(translatedJson({}), existing, staleHashes)
    expect(outcome.staleKeys).toContain("common.save")
    expect(outcome.untranslatedKeys).not.toContain("common.save")
  })

  it("still reports keys from the imported file that no longer exist in the base catalog", () => {
    const outcome = importCatalog(translatedJson({ "nav.retired": "Retired" }), {}, {})
    expect(outcome.unknownKeys).toEqual(["nav.retired"])
  })
})
