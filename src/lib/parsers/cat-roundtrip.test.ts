/**
 * CAT Format Round-Trip Fidelity Tests
 *
 * For each bilingual CAT format we:
 *   1. Start with representative source data (TranslatableString[])
 *   2. Convert to the CellData-compatible shape expected by the exporter
 *   3. Export to a Blob
 *   4. Read the Blob back to a string
 *   5. Re-import using the matching parser
 *   6. Assert that `original` and `translated` text survive
 *
 * Cases with KNOWN acceptable loss are asserted explicitly and marked with
 * SWARM-TODO(roundtrip) comments documenting what is lost.
 *
 * This test documents reality — it must stay GREEN. Known gaps are tested
 * with explicit assertions (not skipped or marked TODO).
 */

import { describe, it, expect } from "vitest"
import { parseXliff } from "./xliff"
import { parseTmx } from "./tmx"
import { parseCsvBilingual } from "./csv-bilingual"
import { exportXliff } from "../export/exporters/xliff"
import { exportTmx } from "../export/exporters/tmx"
import { exportCsv } from "../export/exporters/csv"
import { exportTsv } from "../export/exporters/tsv"
import { exportPlainText } from "../export/exporters/plaintext"
import { exportMarkdown } from "../export/exporters/markdown"

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal CellData-compatible shape required by all bilingual exporters.
 * We only populate fields that the exporters actually read.
 */
interface MinimalCellData {
  id: string
  fileId: string
  original: string
  translated: string
  group: string
  context: string
  type: string
  status: "empty" | "unvalidated" | "validated"
  validationStatus: string
  activeValidators: string[]
  validationHistory: []
  history: []
  threads: []
}

function makeCell(
  id: string,
  original: string,
  translated: string,
  group?: string,
): MinimalCellData {
  return {
    id,
    fileId: "test-file",
    original,
    translated,
    group: group ?? id,
    context: id,
    type: "text",
    status: translated.trim() ? "unvalidated" : "empty",
    validationStatus: "unvalidated",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

/** Read a Blob back to a plain string (Node / happy-dom compatible). */
async function blobText(blob: Blob): Promise<string> {
  return blob.text()
}

// ─── sample data ─────────────────────────────────────────────────────────────

const SAMPLE_CELLS: MinimalCellData[] = [
  makeCell("unit-1", "Hello world", "Bonjour monde", "grp-1"),
  makeCell("unit-2", "Click here to continue", "Cliquez ici pour continuer", "grp-1"),
  makeCell(
    "unit-3",
    "Special chars: <>&\"'",
    "Caractères spéciaux: <>&\"'",
    "grp-2",
  ),
  makeCell(
    "unit-4",
    "Multi-word source with enough text to be realistic",
    "Texte cible multi-mots avec suffisamment de texte",
    "grp-2",
  ),
]

/** A cell with empty translated — used to probe format-specific empty-target behaviour. */
const CELL_EMPTY_TARGET = makeCell("unit-empty", "Source without translation", "", "grp-3")

// ─── XLIFF round-trip ────────────────────────────────────────────────────────

describe("XLIFF 1.2 round-trip", () => {
  it("source and translated text survive export → re-import", async () => {
    // SWARM-TODO(roundtrip): exported XLIFF uses c.group as the trans-unit id.
    //   On re-import the parser assigns a fresh UUID as `id` (not the original
    //   trans-unit id). `group` on re-import is the trans-unit id (= original
    //   c.group) when no ancestor <group> element exists, so group survives.
    //   `context` comes from the <note> which is set to the same id — survives.

    const blob = exportXliff(SAMPLE_CELLS as any, "en", "fr")
    const xml = await blobText(blob)

    const reimported = parseXliff(xml)

    expect(reimported).toHaveLength(SAMPLE_CELLS.length)

    for (let i = 0; i < SAMPLE_CELLS.length; i++) {
      const original = SAMPLE_CELLS[i]
      const roundtripped = reimported[i]

      expect(roundtripped.original).toBe(original.original)
      expect(roundtripped.translated).toBe(original.translated)
    }
  })

  it("special XML characters survive round-trip (entity encoding)", async () => {
    const blob = exportXliff([SAMPLE_CELLS[2]] as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseXliff(xml)

    expect(reimported).toHaveLength(1)
    // SWARM-TODO(roundtrip): exporter XML-escapes & < > " ' via xmlEscape().
    //   The parser uses DOMParser which transparently unescapes entity
    //   references back to raw characters. Verified clean.
    expect(reimported[0].original).toBe("Special chars: <>&\"'")
    expect(reimported[0].translated).toBe("Caractères spéciaux: <>&\"'")
  })

  it("empty-target cell: source survives, translated remains empty", async () => {
    const blob = exportXliff([CELL_EMPTY_TARGET] as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseXliff(xml)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe(CELL_EMPTY_TARGET.original)
    // SWARM-TODO(roundtrip): XLIFF export includes <target state="new"/>
    //   for empty-target cells. The parser reads the (empty) target content
    //   and returns "". Original is preserved.
    expect(reimported[0].translated).toBe("")
  })

  it("group (trans-unit id) is derived from c.group on export and re-appears on re-import", async () => {
    const blob = exportXliff(SAMPLE_CELLS as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseXliff(xml)

    // The exporter writes id="${c.group || c.id}" on the <trans-unit>.
    // The parser: without a <group> ancestor, `group` falls back to the tu id,
    // which is the original c.group. context comes from <note> (= same id).
    for (let i = 0; i < SAMPLE_CELLS.length; i++) {
      expect(reimported[i].context).toBe(SAMPLE_CELLS[i].group)
    }
  })

  it("XLIFF 1.2 re-export is valid XML", async () => {
    const blob = exportXliff(SAMPLE_CELLS as any, "en", "fr")
    const xml = await blobText(blob)
    // Re-parse with the browser XML parser via parseXliff (errors throw)
    expect(() => parseXliff(xml)).not.toThrow()
  })
})

// ─── TMX round-trip ─────────────────────────────────────────────────────────

describe("TMX 1.4b round-trip", () => {
  it("source and translated text survive export → re-import for non-empty pairs", async () => {
    // TMX exporter FILTERS OUT cells where c.translated.trim() is empty.
    const nonEmptyCells = SAMPLE_CELLS.filter((c) => c.translated.trim())

    const blob = exportTmx(nonEmptyCells as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseTmx(xml)

    expect(reimported).toHaveLength(nonEmptyCells.length)

    for (let i = 0; i < nonEmptyCells.length; i++) {
      const original = nonEmptyCells[i]
      const roundtripped = reimported[i]

      expect(roundtripped.original).toBe(original.original)
      expect(roundtripped.translated).toBe(original.translated)
    }
  })

  it("SWARM-TODO(roundtrip): empty-target cells are dropped by TMX exporter", async () => {
    // SWARM-TODO(roundtrip): TMX format only carries translation memory pairs
    //   (both source and target must be non-empty). Cells without a translation
    //   are silently filtered out by exportTmx. This is intentional for TM
    //   exchange but means partial projects lose untranslated segments.
    const cellsWithEmpty = [...SAMPLE_CELLS, CELL_EMPTY_TARGET]
    const blob = exportTmx(cellsWithEmpty as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseTmx(xml)

    // Only non-empty translated cells appear in re-import
    const expectedCount = SAMPLE_CELLS.filter((c) => c.translated.trim()).length
    expect(reimported).toHaveLength(expectedCount)
    // The empty-target cell is NOT in the reimported output
    const reimportedOriginals = reimported.map((r) => r.original)
    expect(reimportedOriginals).not.toContain(CELL_EMPTY_TARGET.original)
  })

  it("special XML characters survive round-trip (entity encoding)", async () => {
    const specialCell = SAMPLE_CELLS[2]
    const blob = exportTmx([specialCell] as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseTmx(xml)

    expect(reimported).toHaveLength(1)
    // SWARM-TODO(roundtrip): exporter XML-escapes & < > " via xmlEscape();
    //   parser DOMParser transparently unescapes. Clean for these characters.
    //   Note: ' (apos) is NOT escaped by the TMX exporter's xmlEscape() —
    //   this is safe since TMX uses double-quote attribute delimiters.
    expect(reimported[0].original).toBe(specialCell.original)
    expect(reimported[0].translated).toBe(specialCell.translated)
  })

  it("group (tuid) is derived from c.group on export and re-appears on re-import", async () => {
    const nonEmptyCells = SAMPLE_CELLS.filter((c) => c.translated.trim())
    const blob = exportTmx(nonEmptyCells as any, "en", "fr")
    const xml = await blobText(blob)
    const reimported = parseTmx(xml)

    // Exporter writes tuid="${c.group || c.id}".
    // Parser puts tuid value into context and group.
    for (let i = 0; i < nonEmptyCells.length; i++) {
      expect(reimported[i].group).toBe(nonEmptyCells[i].group)
    }
  })

  it("TMX re-export is valid XML", async () => {
    const nonEmptyCells = SAMPLE_CELLS.filter((c) => c.translated.trim())
    const blob = exportTmx(nonEmptyCells as any, "en", "fr")
    const xml = await blobText(blob)
    // Errors in TMX parsing throw
    expect(() => parseTmx(xml)).not.toThrow()
  })
})

// ─── CSV round-trip ──────────────────────────────────────────────────────────

describe("CSV round-trip", () => {
  it("source and translated text survive export → re-import", async () => {
    const blob = exportCsv(SAMPLE_CELLS as any)
    const csv = await blobText(blob)
    const reimported = parseCsvBilingual(csv)

    expect(reimported).toHaveLength(SAMPLE_CELLS.length)

    for (let i = 0; i < SAMPLE_CELLS.length; i++) {
      expect(reimported[i].original).toBe(SAMPLE_CELLS[i].original)
      expect(reimported[i].translated).toBe(SAMPLE_CELLS[i].translated)
    }
  })

  it("CSV header row is consumed and not treated as data", async () => {
    const blob = exportCsv(SAMPLE_CELLS as any)
    const csv = await blobText(blob)

    // Exporter writes "id,source,target" as first row.
    expect(csv).toMatch(/^id,source,target/)

    const reimported = parseCsvBilingual(csv)
    // Header row must NOT appear as a data row
    expect(reimported[0].original).not.toBe("source")
  })

  it("empty-target cell: source survives, translated is empty", async () => {
    const blob = exportCsv([CELL_EMPTY_TARGET] as any)
    const csv = await blobText(blob)
    const reimported = parseCsvBilingual(csv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe(CELL_EMPTY_TARGET.original)
    expect(reimported[0].translated).toBe("")
  })

  it("group/id column survives as context on re-import", async () => {
    const blob = exportCsv(SAMPLE_CELLS as any)
    const csv = await blobText(blob)
    const reimported = parseCsvBilingual(csv)

    // Exporter writes c.group || c.id as first column (the id column).
    // Parser detects 3-column layout with id column → puts id value in context/group.
    for (let i = 0; i < SAMPLE_CELLS.length; i++) {
      expect(reimported[i].context).toBe(SAMPLE_CELLS[i].group)
    }
  })

  it("RFC-4180 quoting: fields with commas survive round-trip", async () => {
    const cellWithComma = makeCell("c1", "Hello, world", "Bonjour, monde", "grp-comma")
    const blob = exportCsv([cellWithComma] as any)
    const csv = await blobText(blob)
    const reimported = parseCsvBilingual(csv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe("Hello, world")
    expect(reimported[0].translated).toBe("Bonjour, monde")
  })

  it("RFC-4180 quoting: fields with double-quotes survive round-trip", async () => {
    const cellWithQuote = makeCell('q1', 'She said "hello"', 'Elle a dit "bonjour"', "grp-quote")
    const blob = exportCsv([cellWithQuote] as any)
    const csv = await blobText(blob)
    const reimported = parseCsvBilingual(csv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe('She said "hello"')
    expect(reimported[0].translated).toBe('Elle a dit "bonjour"')
  })

  it("SWARM-TODO(roundtrip): multi-line source text survives CSV round-trip", async () => {
    // SWARM-TODO(roundtrip): CSV exporter quotes newline-containing fields per
    //   RFC-4180. The parser preserves embedded newlines inside quoted fields.
    //   Multi-line text survives the CSV round-trip without loss.
    const cellWithNewline = makeCell(
      "nl1",
      "Line one\nLine two",
      "Ligne un\nLigne deux",
      "grp-nl",
    )
    const blob = exportCsv([cellWithNewline] as any)
    const csv = await blobText(blob)
    const reimported = parseCsvBilingual(csv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe("Line one\nLine two")
    expect(reimported[0].translated).toBe("Ligne un\nLigne deux")
  })
})

// ─── TSV round-trip ──────────────────────────────────────────────────────────

describe("TSV round-trip", () => {
  it("source and translated text survive export → re-import (all sample cells including quotes)", async () => {
    // TSV exporter now uses RFC-4180 quoting: fields containing ", \t, \r, or
    // \n are wrapped in double-quotes with internal " doubled. The TSV parser
    // (parseCsvRows) already handled quoted fields — it auto-detects the tab
    // delimiter and applies the same RFC-4180 logic as the CSV path.
    const blob = exportTsv(SAMPLE_CELLS as any)
    const tsv = await blobText(blob)
    const reimported = parseCsvBilingual(tsv)

    expect(reimported).toHaveLength(SAMPLE_CELLS.length)

    for (let i = 0; i < SAMPLE_CELLS.length; i++) {
      expect(reimported[i].original).toBe(SAMPLE_CELLS[i].original)
      expect(reimported[i].translated).toBe(SAMPLE_CELLS[i].translated)
    }
  })

  it("RFC-4180 quoting: double-quote characters in TSV fields survive round-trip", async () => {
    // TSV exporter wraps fields containing " in double-quotes and doubles
    // internal quotes (""). parseCsvRows handles the quoted field correctly.
    const cellWithQuote = makeCell("q1", 'She said "hello"', 'Elle dit "bonjour"', "grp-q")
    const blob = exportTsv([cellWithQuote] as any)
    const tsv = await blobText(blob)
    const reimported = parseCsvBilingual(tsv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe('She said "hello"')
    expect(reimported[0].translated).toBe('Elle dit "bonjour"')
  })

  it("TSV header row is consumed and not treated as data", async () => {
    const blob = exportTsv(SAMPLE_CELLS as any)
    const tsv = await blobText(blob)

    expect(tsv).toMatch(/^id\tsource\ttarget/)

    const reimported = parseCsvBilingual(tsv)
    expect(reimported[0].original).not.toBe("source")
  })

  it("RFC-4180 quoting: tabs embedded in source/target survive round-trip", async () => {
    // TSV exporter wraps fields containing \t in double-quotes. parseCsvRows
    // treats the quoted field as a single unit, preserving the embedded tab.
    const cellWithTab = makeCell("tab1", "Hello\tworld", "Bonjour\tmonde", "grp-tab")
    const blob = exportTsv([cellWithTab] as any)
    const tsv = await blobText(blob)
    const reimported = parseCsvBilingual(tsv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe("Hello\tworld")
    expect(reimported[0].translated).toBe("Bonjour\tmonde")
  })

  it("RFC-4180 quoting: newlines in source/target survive round-trip", async () => {
    // TSV exporter wraps fields containing \n in double-quotes. parseCsvRows
    // accumulates the embedded newline inside the quoted field instead of
    // treating it as a row separator.
    const cellWithNewline = makeCell(
      "nl1",
      "Line one\nLine two",
      "Ligne un\nLigne deux",
      "grp-nl",
    )
    const blob = exportTsv([cellWithNewline] as any)
    const tsv = await blobText(blob)
    const reimported = parseCsvBilingual(tsv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe("Line one\nLine two")
    expect(reimported[0].translated).toBe("Ligne un\nLigne deux")
  })

  it("empty-target cell: source survives, translated is empty", async () => {
    const blob = exportTsv([CELL_EMPTY_TARGET] as any)
    const tsv = await blobText(blob)
    const reimported = parseCsvBilingual(tsv)

    expect(reimported).toHaveLength(1)
    expect(reimported[0].original).toBe(CELL_EMPTY_TARGET.original)
    expect(reimported[0].translated).toBe("")
  })
})

// ─── Plain text & Markdown: no round-trip (target-only) ─────────────────────

describe("Plain text — no meaningful round-trip", () => {
  it("SWARM-TODO(roundtrip): plain text exporter emits translated-only (source is lost)", async () => {
    // SWARM-TODO(roundtrip): exportPlainText() outputs only the `translated`
    //   value of each cell, one per line. The source text is completely absent
    //   from the output. There is no inverse parser that can recover a
    //   TranslatableString[] from a plain text file with both source and target.
    //   Plain text export is one-way: suitable for delivery to end users, not
    //   for translator hand-off or TM exchange.

    // We document this by showing the plain text exporter does NOT produce
    // something parseable back to bilingual data:
    const nonEmptyCells = SAMPLE_CELLS.filter((c) => c.translated.trim())

    const blob = exportPlainText(nonEmptyCells as any)
    // We do not attempt to re-import — there is no bilingual plain text parser.
    expect(blob).toBeInstanceOf(Blob)
    // The blob contains only the translated lines, no source
    const txt = await blobText(blob)
    for (const cell of nonEmptyCells) {
      expect(txt).toContain(cell.translated.trim())
    }
    // Source text is absent from the output
    for (const cell of nonEmptyCells) {
      expect(txt).not.toContain(cell.original)
    }
  })
})

describe("Markdown — no meaningful round-trip", () => {
  it("SWARM-TODO(roundtrip): markdown exporter emits translated-only with group anchors (source is lost)", async () => {
    // SWARM-TODO(roundtrip): exportMarkdown() outputs only `translated` text
    //   with group-based HTML comment anchors (<!-- group -->). The source text
    //   is completely absent. While extractMarkdownStrings() can parse Markdown
    //   back into segments, there is no way to recover the original source text
    //   from the exported output — the Markdown parser produces new segments
    //   where `original` === the translated text content.
    //   Markdown export is one-way: suitable for publication, not for
    //   bilingual exchange or round-trip editing.

    const nonEmptyCells = SAMPLE_CELLS.filter((c) => c.translated.trim())

    const blob = exportMarkdown(nonEmptyCells as any)
    expect(blob).toBeInstanceOf(Blob)
    const md = await blobText(blob)
    for (const cell of nonEmptyCells) {
      expect(md).toContain(cell.translated.trim())
    }
    // Source text is absent from the markdown output
    for (const cell of nonEmptyCells) {
      expect(md).not.toContain(cell.original)
    }
  })
})

// ─── Cross-format text identity check ────────────────────────────────────────

describe("Cross-format: all bilingual formats preserve identical text", () => {
  it("XLIFF, TMX, and CSV all produce the same original/translated text on re-import", async () => {
    const cells = SAMPLE_CELLS.filter((c) => c.translated.trim())

    const xliffBlob = exportXliff(cells as any, "en", "fr")
    const tmxBlob = exportTmx(cells as any, "en", "fr")
    const csvBlob = exportCsv(cells as any)

    const [xliffXml, tmxXml, csvText] = await Promise.all([
      blobText(xliffBlob),
      blobText(tmxBlob),
      blobText(csvBlob),
    ])

    const fromXliff = parseXliff(xliffXml)
    const fromTmx = parseTmx(tmxXml)
    const fromCsv = parseCsvBilingual(csvText)

    expect(fromXliff).toHaveLength(cells.length)
    expect(fromTmx).toHaveLength(cells.length)
    expect(fromCsv).toHaveLength(cells.length)

    for (let i = 0; i < cells.length; i++) {
      // All three formats should agree on original text
      expect(fromXliff[i].original).toBe(cells[i].original)
      expect(fromTmx[i].original).toBe(cells[i].original)
      expect(fromCsv[i].original).toBe(cells[i].original)

      // All three formats should agree on translated text
      expect(fromXliff[i].translated).toBe(cells[i].translated)
      expect(fromTmx[i].translated).toBe(cells[i].translated)
      expect(fromCsv[i].translated).toBe(cells[i].translated)
    }
  })
})
