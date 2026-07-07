import { describe, it, expect } from "vitest"
import { extractPoStrings, exportPo } from "./po"
import type { TranslatableString } from "./types"
import type { CellData } from "@/hooks/useCells"

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal CellData-compatible shape — exportPo only reads `translated`. */
function makeCells(translated: string[]): CellData[] {
  const cells = translated.map((t, i) => ({
    id: `cell-${i}`,
    fileId: "test-file",
    original: "",
    translated: t,
    context: "",
    group: "",
    type: "text",
    status: t ? "unvalidated" : "empty",
    validationStatus: "unvalidated",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }))
  return cells as unknown as CellData[]
}

/** Cells whose translations mirror what extraction produced (an "untouched" export). */
function cellsFrom(strings: TranslatableString[]): CellData[] {
  return makeCells(strings.map((s) => s.translated))
}

// ─── sample documents ────────────────────────────────────────────────────────

const SAMPLE = [
  `# Translator comment`,
  `#. Extracted comment`,
  `#, fuzzy`,
  `msgid ""`,
  `msgstr ""`,
  `"Project-Id-Version: demo 1.0\\n"`,
  `"Content-Type: text/plain; charset=UTF-8\\n"`,
  ``,
  `#: src/app.c:10`,
  `msgid "Hello"`,
  `msgstr "Bonjour"`,
  ``,
  `msgctxt "menu"`,
  `msgid "Open"`,
  `msgstr "Ouvrir"`,
  ``,
  `#: src/files.c:7`,
  `msgid "One file"`,
  `msgid_plural "%d files"`,
  `msgstr[0] "Un fichier"`,
  `msgstr[1] "%d fichiers"`,
  ``,
  `msgid "Untranslated"`,
  `msgstr ""`,
  ``,
  `msgid "He said \\"hi\\"\\n"`,
  `msgstr "Il a dit \\"salut\\"\\n"`,
  ``,
].join("\n")

const MULTILINE = [
  `msgid ""`,
  `msgstr ""`,
  `"Content-Type: text/plain; charset=UTF-8\\n"`,
  ``,
  `msgid ""`,
  `"Line one "`,
  `"line two"`,
  `msgstr ""`,
  `"Ligne un "`,
  `"ligne deux"`,
  ``,
].join("\n")

// ─── extraction ──────────────────────────────────────────────────────────────

describe("extractPoStrings", () => {
  it("extracts basic entries in order with type text and fresh ids", () => {
    const strings = extractPoStrings(SAMPLE)
    expect(strings.map((s) => s.original)).toEqual([
      "Hello",
      "Open",
      "One file",
      "%d files",
      "Untranslated",
      'He said "hi"\n',
    ])
    expect(strings[0].translated).toBe("Bonjour")
    expect(strings.every((s) => s.type === "text")).toBe(true)
    expect(new Set(strings.map((s) => s.id)).size).toBe(strings.length)
  })

  it("skips the header entry (msgid \"\")", () => {
    const strings = extractPoStrings(SAMPLE)
    expect(strings.some((s) => s.original.startsWith("Project-Id-Version"))).toBe(false)
    expect(strings.some((s) => s.original === "" && s.translated.includes("charset"))).toBe(false)
  })

  it("uses msgctxt as context and joins it into group with U+0004", () => {
    const open = extractPoStrings(SAMPLE).find((s) => s.original === "Open")
    expect(open).toBeDefined()
    expect(open?.context).toBe("menu")
    expect(open?.group).toBe("Open\u0004menu")
  })

  it("uses the first #: reference as context when there is no msgctxt", () => {
    const hello = extractPoStrings(SAMPLE).find((s) => s.original === "Hello")
    expect(hello?.context).toBe("src/app.c:10")
    expect(hello?.group).toBe("Hello")
  })

  it("falls back to msgid as context when no msgctxt and no reference", () => {
    const plain = extractPoStrings(SAMPLE).find((s) => s.original === "Untranslated")
    expect(plain?.context).toBe("Untranslated")
  })

  it("emits one string per plural form with group msgid#N", () => {
    const strings = extractPoStrings(SAMPLE)
    const zero = strings.find((s) => s.group === "One file#0")
    const one = strings.find((s) => s.group === "One file#1")
    expect(zero).toMatchObject({ original: "One file", translated: "Un fichier" })
    expect(one).toMatchObject({ original: "%d files", translated: "%d fichiers" })
  })

  it("emits indices 0..1 for a plural entry with no msgstr[N] lines", () => {
    const po = `msgid "One apple"\nmsgid_plural "%d apples"\n`
    const strings = extractPoStrings(po)
    expect(strings).toHaveLength(2)
    expect(strings[0]).toMatchObject({ original: "One apple", translated: "", group: "One apple#0" })
    expect(strings[1]).toMatchObject({ original: "%d apples", translated: "", group: "One apple#1" })
  })

  it("unescapes \\\" \\\\ \\n \\t", () => {
    const po = `msgid "a\\tb\\\\c"\nmsgstr "x \\"y\\" z\\n"\n`
    const [s] = extractPoStrings(po)
    expect(s.original).toBe("a\tb\\c")
    expect(s.translated).toBe('x "y" z\n')
  })

  it("concatenates multi-line continuations for msgid and msgstr", () => {
    const strings = extractPoStrings(MULTILINE)
    expect(strings).toHaveLength(1)
    expect(strings[0].original).toBe("Line one line two")
    expect(strings[0].translated).toBe("Ligne un ligne deux")
  })

  it("gives translated \"\" for an empty msgstr", () => {
    const s = extractPoStrings(SAMPLE).find((x) => x.original === "Untranslated")
    expect(s?.translated).toBe("")
  })
})

// ─── export ──────────────────────────────────────────────────────────────────

describe("exportPo", () => {
  it("substitutes translations positionally into msgstr lines", async () => {
    const cells = makeCells(["Hallo", "Öffnen", "Eine Datei", "%d Dateien", "Unübersetzt", 'Er sagte "hi"\n'])
    const text = await exportPo(SAMPLE, cells).text()
    expect(text).toContain(`msgstr "Hallo"`)
    expect(text).toContain(`msgstr "Öffnen"`)
    expect(text).toContain(`msgstr[0] "Eine Datei"`)
    expect(text).toContain(`msgstr[1] "%d Dateien"`)
    expect(text).toContain(`msgstr "Unübersetzt"`)
    expect(text).toContain(`msgstr "Er sagte \\"hi\\"\\n"`)
  })

  it("keeps the original msgstr when a cell has no translation, never copying msgid", async () => {
    // Only translate the first cell; everything else falls back.
    const cells = makeCells(["Hallo", "", "", "", "", ""])
    const text = await exportPo(SAMPLE, cells).text()
    expect(text).toContain(`msgstr "Hallo"`)
    expect(text).toContain(`msgstr "Ouvrir"`)          // fallback: original kept
    expect(text).toContain(`msgstr[0] "Un fichier"`)   // fallback: original kept
    // The originally-empty msgstr stays empty — msgid is NOT copied in.
    expect(text).toContain(`msgid "Untranslated"\nmsgstr ""`)
  })

  it("preserves comments, flags, references, and the header unchanged", async () => {
    const cells = makeCells(["Hallo", "Öffnen", "Eine Datei", "%d Dateien", "", ""])
    const text = await exportPo(SAMPLE, cells).text()
    expect(text).toContain("# Translator comment")
    expect(text).toContain("#. Extracted comment")
    expect(text).toContain("#, fuzzy")
    expect(text).toContain("#: src/app.c:10")
    expect(text).toContain("#: src/files.c:7")
    // Header entry passes through verbatim, including its continuation lines.
    expect(text).toContain(`msgid ""\nmsgstr ""\n"Project-Id-Version: demo 1.0\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"`)
  })

  it("escapes quotes, backslashes, and real newlines back into PO syntax", async () => {
    const po = `msgid "src"\nmsgstr ""\n`
    const cells = makeCells(['He said "no"\\maybe\nnext'])
    const text = await exportPo(po, cells).text()
    expect(text).toContain(`msgstr "He said \\"no\\"\\\\maybe\\nnext"`)
  })

  it("collapses a multi-line original msgstr to a single quoted line when substituting", async () => {
    const cells = makeCells(["Zeile eins zeile zwei"])
    const text = await exportPo(MULTILINE, cells).text()
    expect(text).toContain(`msgstr "Zeile eins zeile zwei"`)
    expect(text).not.toContain(`"Ligne un "`)
    expect(text).not.toContain(`"ligne deux"`)
    // The multi-line msgid is untouched.
    expect(text).toContain(`msgid ""\n"Line one "\n"line two"`)
  })

  it("keeps positional alignment across a plural entry with no msgstr[N] lines", async () => {
    const po = [
      `msgid "One apple"`,
      `msgid_plural "%d apples"`,
      ``,
      `msgid "Pear"`,
      `msgstr ""`,
      ``,
    ].join("\n")
    // The plural entry consumed cells 0..1 in extraction order; "Birne" is cell 2.
    const cells = makeCells(["x", "y", "Birne"])
    const text = await exportPo(po, cells).text()
    expect(text).toContain(`msgid "Pear"\nmsgstr "Birne"`)
  })

  it("round-trips: extract(export(...)) yields the translated values", async () => {
    const translations = ["Hallo", "Öffnen", "Eine Datei", "%d Dateien", "", 'Er sagte "hi"\n']
    const text = await exportPo(SAMPLE, makeCells(translations)).text()
    const reimported = extractPoStrings(text)
    expect(reimported.map((s) => s.original)).toEqual(extractPoStrings(SAMPLE).map((s) => s.original))
    expect(reimported.map((s) => s.translated)).toEqual(translations)
  })

  it("exports an untouched canonical file byte-identically", async () => {
    // Every msgstr in SAMPLE is single-line with canonical escaping, so
    // re-emitting the extracted translations reproduces the exact bytes.
    const text = await exportPo(SAMPLE, cellsFrom(extractPoStrings(SAMPLE))).text()
    expect(text).toBe(SAMPLE)
  })

  it("untouched export differs from the original only in msgstr lines with non-empty translations", async () => {
    const text = await exportPo(MULTILINE, cellsFrom(extractPoStrings(MULTILINE))).text()
    // The exported file is identical to the original except the one msgstr
    // that carried a non-empty translation: its keyword line + continuation
    // lines collapse to a single canonical line. Header, comments, blank
    // lines, and the multi-line msgid all pass through byte-for-byte.
    const expected = [
      `msgid ""`,
      `msgstr ""`,
      `"Content-Type: text/plain; charset=UTF-8\\n"`,
      ``,
      `msgid ""`,
      `"Line one "`,
      `"line two"`,
      `msgstr "Ligne un ligne deux"`,
      ``,
    ].join("\n")
    expect(text).toBe(expected)
  })
})
