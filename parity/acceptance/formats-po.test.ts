// Acceptance test for the gettext PO row of PARITY_MATRIX.yaml.
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { extractPoStrings, exportPo } from "@/lib/parsers/po"

const toCells = (strings: TranslatableString[], translate?: (s: string) => string): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id || `c${i}`,
        fileId: "f",
        original: s.original,
        translated: translate ? translate(s.original) : s.translated,
        group: s.group || s.id,
        context: s.context ?? "",
        type: s.type,
        status: "unvalidated",
        validationStatus: "unvalidated",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
      }) as unknown as CellData,
  )

const PO = `# Translators comment
msgid ""
msgstr ""
"Project-Id-Version: demo\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

#. developer note
#: src/app.ts:12
msgid "Save your \\"work\\" now"
msgstr ""

#: src/app.ts:20
msgid "One item"
msgid_plural "Many items"
msgstr[0] "Un élément"
msgstr[1] "Plusieurs éléments"

msgctxt "button"
msgid "Close"
msgstr "Fermer"
`

describe("gettext PO", () => {
  it("[fmt.po.roundtrip] msgid/msgstr pairs import with comments, plurals and context preserved on export", async () => {
    const strings = extractPoStrings(PO)
    // header skipped; 1 plain + 2 plural forms + 1 msgctxt entry
    expect(strings).toHaveLength(4)
    expect(strings[0].original).toBe('Save your "work" now')
    expect(strings[0].translated).toBe("")
    expect(strings[1].original).toBe("One item")
    expect(strings[1].translated).toBe("Un élément")
    expect(strings[2].original).toBe("Many items")
    expect(strings[3].original).toBe("Close")
    expect(strings[3].context).toBe("button")

    const out = await exportPo(PO, toCells(strings, (s) => `«${s}»`)).text()
    // headers, comments, references, flags all pass through
    expect(out).toContain("# Translators comment")
    expect(out).toContain("#. developer note")
    expect(out).toContain("#: src/app.ts:12")
    expect(out).toContain('"Plural-Forms: nplurals=2; plural=(n != 1);\\n"')
    expect(out).toContain("msgctxt \"button\"")
    // translations substituted with correct escaping; msgid lines untouched
    expect(out).toContain('msgid "Save your \\"work\\" now"')
    expect(out).toContain('msgstr "«Save your \\"work\\" now»"')
    expect(out).toContain('msgstr[0] "«One item»"')
    expect(out).toContain('msgstr[1] "«Many items»"')
    // re-import gives the translations back under the same entries
    const reparsed = extractPoStrings(out)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
    expect(reparsed.map((s) => s.translated)).toEqual(strings.map((s) => `«${s.original}»`))
  })
})
