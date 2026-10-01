import { beforeAll, describe, expect, it } from "vitest"

import { LANGUAGES, filterLanguages, isSettledLanguage, type LanguageEntry } from "./catalog"
import {
  loadFullLanguageCatalog,
  parseIso639_3Table,
  peekFullLanguageCatalog,
} from "./full-catalog"

/**
 * AQU-1456 — the language pickers must offer the whole SIL ISO 639-3 table,
 * not just the ~184 ISO 639-1 majors, because most languages our translators
 * work in are low-resource. These cases are the ticket's acceptance criteria.
 */

let catalog: readonly LanguageEntry[]
const names = (query: string, options: { limit?: number } = {}) =>
  filterLanguages(query, { ...options, catalog }).map((entry) => entry.name)

beforeAll(async () => {
  catalog = await loadFullLanguageCatalog()
})

describe("the full ISO 639-3 catalog", () => {
  it("covers the whole table, not just the bundled majors", () => {
    expect(catalog.length).toBeGreaterThan(7900)
    expect(catalog.length).toBeGreaterThan(LANGUAGES.length * 40)
  })

  it("is memoized — a second load is the same array, and peek sees it", () => {
    expect(peekFullLanguageCatalog()).toBe(catalog)
    expect(loadFullLanguageCatalog()).resolves.toBe(catalog)
  })

  it("has unique codes and display names", () => {
    expect(new Set(catalog.map((entry) => entry.code)).size).toBe(catalog.length)
    expect(new Set(catalog.map((entry) => entry.name)).size).toBe(catalog.length)
  })

  it("shows 639-3 codes as the hint and keeps 639-1 as a second search key", () => {
    for (const entry of catalog) {
      expect(entry.code).toMatch(/^[a-z]{3}$/)
      if (entry.altCode !== undefined) expect(entry.altCode).toMatch(/^[a-z]{2}$/)
    }
    const french = catalog.find((entry) => entry.name === "French")
    expect(french).toEqual({ code: "fra", name: "French", altCode: "fr" })
  })

  it("keeps SIL's spacing instead of Codex's space-stripped names", () => {
    // Codex's generated array space-strips `Ref_Name`, so the same entries
    // read "ArmenianSignLanguage" / "EasternArrernte" there.
    for (const name of [
      "Armenian Sign Language",
      "Eastern Arrernte",
      "Pattani Malay",
      "Adamawa Fulfulde",
    ]) {
      expect(names(name)).toContain(name)
      expect(names(name.replace(/ /g, ""))).toEqual([])
    }
    // Spacing is the norm, not an exception: most of the table is multi-word.
    const spaced = catalog.filter((entry) => entry.name.includes(" "))
    expect(spaced.length).toBeGreaterThan(2000)
  })
})

describe("low-resource languages the ISO 639-1 catalog could not suggest", () => {
  it.each([
    ["Eastern Arrernte", "aer"],
    ["Pattani Malay", "mfa"],
    ["Kalam", "kmh"],
    ["Adamawa Fulfulde", "fub"],
    ["Tok Pisin", "tpi"],
  ])("suggests %s by name and by code %s", (name, code) => {
    // Exact-name query ranks the language itself first ("Kalam" also
    // prefix-matches "Kalamsé").
    expect(names(name)[0]).toBe(name)
    expect(catalog).toContainEqual({ code, name })
    expect(names(code)[0]).toBe(name)
    // The regression this guards: none of these were in the bundled set.
    expect(filterLanguages(name)).toEqual([])
  })

  it("pins Codex's Biblical-languages entry under `blg` and its name", () => {
    expect(names("blg")[0]).toBe("Biblical Hebrew/Aramaic/Greek")
    expect(names("Biblical Hebrew")).toContain("Biblical Hebrew/Aramaic/Greek")
  })
})

describe("the widened catalog keeps the AQU-988 contract", () => {
  it("still finds majors by name, 639-1 code and 639-3 code", () => {
    expect(names("French")[0]).toBe("French")
    expect(names("fr")[0]).toBe("French")
    expect(names("fra")[0]).toBe("French")
    expect(names("en")[0]).toBe("English")
    expect(names("eng")[0]).toBe("English")
  })

  it("suggests nothing for a freeform register label", () => {
    expect(filterLanguages("Grade 7 English", { catalog })).toEqual([])
  })

  it("still caps the rendered list", () => {
    expect(filterLanguages("a", { catalog, limit: 5 })).toHaveLength(5)
    expect(filterLanguages("", { catalog })).toHaveLength(50)
  })

  it("still drops excluded values and settles on an exact single match", () => {
    expect(
      filterLanguages("Eastern Arrernte", { catalog, exclude: ["eastern arrernte"] }),
    ).toEqual([])
    expect(
      isSettledLanguage("Eastern Arrernte", filterLanguages("Eastern Arrernte", { catalog })),
    ).toBe(true)
  })
})

describe("parseIso639_3Table", () => {
  it("skips blank and malformed lines rather than emitting junk entries", () => {
    expect(parseIso639_3Table("aer\t\tEastern Arrernte\n\nfra\tfr\tFrench\n\t\t\nxxx\t\t")).toEqual([
      { code: "aer", name: "Eastern Arrernte" },
      { code: "fra", name: "French", altCode: "fr" },
    ])
  })
})

describe("the table stays out of the initial bundle", () => {
  /**
   * The lazy-load acceptance criterion is a bundling property, so guard it
   * where it can break: this module must reach the ~145 KB table only through
   * `import()`. Turning that into a static `import { ISO_639_3_TABLE } from
   * "./iso-639-3-table"` still typechecks and still passes every test above,
   * while silently moving the table into the entry chunk.
   */
  it("reaches the table only through a dynamic import", async () => {
    const source: string = (await import("./full-catalog.ts?raw")).default

    expect(source).toContain('import("./iso-639-3-table")')
    expect(source).not.toMatch(/^\s*import\b[^\n]*iso-639-3-table/m)
    expect(source).not.toMatch(/^\s*export\b[^\n]*from[^\n]*iso-639-3-table/m)
  })
})
