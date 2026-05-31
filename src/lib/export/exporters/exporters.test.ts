import { describe, it, expect } from "vitest"
import { exportPlainText } from "./plaintext"
import { exportMarkdown } from "./markdown"
import { exportTsv } from "./tsv"
import { exportCsv } from "./csv"
import { exportXliff } from "./xliff"
import { exportTmx } from "./tmx"
import type { CellData } from "@/hooks/useCells"

// Minimal CellData stub — only the fields the exporters actually read.
function makeCell(overrides: Partial<CellData>): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "Hello world",
    translated: "Bonjour monde",
    context: "",
    group: "GEN 1:1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

const CELLS: CellData[] = [
  makeCell({ id: "c1", group: "GEN 1:1", original: "In the beginning", translated: "Au commencement" }),
  makeCell({ id: "c2", group: "GEN 1:2", original: "The earth was formless", translated: "La terre était informe" }),
  makeCell({ id: "c3", group: "GEN 1:3", original: "God said", translated: "" }), // empty target
]

async function blobText(blob: Blob): Promise<string> {
  return blob.text()
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------
describe("exportPlainText", () => {
  it("emits only non-empty translated segments, one per line", async () => {
    const blob = exportPlainText(CELLS)
    const text = await blobText(blob)
    const lines = text.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe("Au commencement")
    expect(lines[1]).toBe("La terre était informe")
  })

  it("produces text/plain content type", () => {
    expect(exportPlainText(CELLS).type).toContain("text/plain")
  })

  it("returns empty blob for all-empty cells", async () => {
    const blob = exportPlainText([makeCell({ translated: "" })])
    expect(await blobText(blob)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
describe("exportMarkdown", () => {
  it("includes group as HTML comment anchor before each segment", async () => {
    const blob = exportMarkdown(CELLS)
    const text = await blobText(blob)
    expect(text).toContain("<!-- GEN 1:1 -->")
    expect(text).toContain("Au commencement")
    expect(text).toContain("<!-- GEN 1:2 -->")
    expect(text).toContain("La terre était informe")
  })

  it("skips cells with empty translated text", async () => {
    const blob = exportMarkdown(CELLS)
    const text = await blobText(blob)
    expect(text).not.toContain("GEN 1:3")
  })
})

// ---------------------------------------------------------------------------
// TSV
// ---------------------------------------------------------------------------
describe("exportTsv", () => {
  it("has id/source/target header", async () => {
    const blob = exportTsv(CELLS)
    const lines = (await blobText(blob)).split("\n")
    expect(lines[0]).toBe("id\tsource\ttarget")
  })

  it("emits all cells including empty targets", async () => {
    const blob = exportTsv(CELLS)
    const lines = (await blobText(blob)).split("\n")
    expect(lines).toHaveLength(4) // header + 3 cells
  })

  it("RFC-4180 quotes tab-containing fields so column count stays 3 when parsed correctly", async () => {
    // Fields containing tabs are quoted per RFC-4180. A naive split("\t") will
    // count extra separators inside the quoted field — the correct way is to
    // use a quote-aware parser (parseCsvRows). We verify both that the raw TSV
    // contains quotes around the field AND that the round-trip recovers the
    // original text including the embedded tab.
    const cell = makeCell({ original: "col1\tcol2", translated: "cible1\tcible2", group: "GEN 1:1" })
    const blob = exportTsv([cell])
    const tsv = await blobText(blob)

    // The field must be quoted in the raw output
    expect(tsv).toContain('"col1\tcol2"')

    // Round-trip via the RFC-4180 parser produces exactly 1 row with original text
    const { parseCsvRows } = await import("@/lib/parsers/csv-bilingual")
    const rows = parseCsvRows(tsv)
    // header + 1 data row
    expect(rows).toHaveLength(2)
    // Data row has exactly 3 columns
    expect(rows[1]).toHaveLength(3)
    // Embedded tab preserved
    expect(rows[1][1]).toBe("col1\tcol2")
    expect(rows[1][2]).toBe("cible1\tcible2")
  })
})

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
describe("exportCsv", () => {
  it("has id,source,target header", async () => {
    const blob = exportCsv(CELLS)
    const lines = (await blobText(blob)).split("\r\n")
    expect(lines[0]).toBe("id,source,target")
  })

  it("wraps fields containing commas in double-quotes", async () => {
    const cell = makeCell({ original: "one, two, three", translated: "un, deux, trois", group: "GEN 1:1" })
    const blob = exportCsv([cell])
    const text = await blobText(blob)
    expect(text).toContain('"one, two, three"')
    expect(text).toContain('"un, deux, trois"')
  })

  it("escapes double-quotes inside quoted fields (RFC 4180)", async () => {
    const cell = makeCell({ original: 'say "hello"', translated: 'dire "bonjour"', group: "GEN 1:1" })
    const blob = exportCsv([cell])
    const text = await blobText(blob)
    expect(text).toContain('"say ""hello"""')
    expect(text).toContain('"dire ""bonjour"""')
  })

  it("uses CRLF line endings per RFC 4180", async () => {
    const blob = exportCsv(CELLS)
    const text = await blobText(blob)
    expect(text).toContain("\r\n")
  })
})

// ---------------------------------------------------------------------------
// XLIFF 1.2
// ---------------------------------------------------------------------------
describe("exportXliff", () => {
  it("produces valid-looking XLIFF envelope", async () => {
    const blob = exportXliff(CELLS, "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain('xliff version="1.2"')
    expect(text).toContain('source-language="en"')
    expect(text).toContain('target-language="fr"')
  })

  it("emits trans-unit for each cell with correct state", async () => {
    const validatedCell = makeCell({
      id: "vc", group: "MAT 1:1", original: "src", translated: "tgt", status: "validated",
    })
    const emptyCell = makeCell({
      id: "ec", group: "MAT 1:2", original: "src2", translated: "", status: "empty",
    })
    const blob = exportXliff([validatedCell, emptyCell], "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain('state="final"')
    expect(text).toContain('state="new"')
  })

  it("XML-escapes ampersands in values", async () => {
    const cell = makeCell({ original: "bread & fish", translated: "pain & poisson", group: "MAT 1:1" })
    const blob = exportXliff([cell], "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain("bread &amp; fish")
    expect(text).toContain("pain &amp; poisson")
  })
})

// ---------------------------------------------------------------------------
// TMX 1.4b
// ---------------------------------------------------------------------------
describe("exportTmx", () => {
  it("produces a TMX envelope with header and body", async () => {
    const blob = exportTmx(CELLS, "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain('<tmx version="1.4">')
    expect(text).toContain("<header")
    expect(text).toContain('srclang="en"')
    expect(text).toContain("<body>")
  })

  it("only includes cells where both source and target are non-empty", async () => {
    const blob = exportTmx(CELLS, "en", "fr")
    const text = await blobText(blob)
    // c3 has empty translated — should be absent
    const tuCount = (text.match(/<tu /g) ?? []).length
    expect(tuCount).toBe(2)
  })

  it("XML-escapes special characters", async () => {
    const cell = makeCell({ original: "a < b", translated: "a < b" })
    const blob = exportTmx([cell], "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain("a &lt; b")
  })
})
