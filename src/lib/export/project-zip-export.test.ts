/**
 * Tests for project-zip-export: the pure aggregation + zip helper that
 * powers whole-project client-side export.
 *
 * We test:
 * 1. exportFileCells() dispatches to the right per-format exporter.
 * 2. buildProjectZip() produces a valid zip with one entry per file.
 * 3. Entry names strip the original extension and append the format ext.
 * 4. Empty file lists produce a valid (empty) zip rather than throwing.
 * 5. Files with zero cells are included (exporters handle empty gracefully).
 */

import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { exportFileCells, buildProjectZip } from "./project-zip-export"
import type { ProjectFileCellsInput } from "./project-zip-export"

// ── Helpers ──────────────────────────────────────────────────────────────

function makeCell(overrides: Partial<CellData> = {}): CellData {
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
]

async function blobText(blob: Blob): Promise<string> {
  return blob.text()
}

// ── exportFileCells ───────────────────────────────────────────────────────

describe("exportFileCells", () => {
  it("txt: returns plain text blob with translated lines", async () => {
    const blob = exportFileCells(CELLS, "txt", "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain("Au commencement")
    expect(text).toContain("La terre était informe")
    expect(blob.type).toContain("text/plain")
  })

  // 2026-07-04 parity run (principal directive: exports must round-trip):
  // exportFileCells("md") now uses the structure-preserving markdown exporter,
  // which emits NO anchor comments — they re-imported as paragraph text and
  // broke the round trip. Assertion updated accordingly (logged in
  // ITERATION_LOG.md cycle 11); the legacy anchor exporter (exportMarkdown)
  // still exists with its own untouched tests.
  it("md: returns round-trip markdown blob without anchor comments", async () => {
    const blob = exportFileCells(CELLS, "md", "en", "fr")
    const text = await blobText(blob)
    expect(text).not.toContain("<!--")
    expect(text).toContain("Au commencement")
  })

  it("tsv: returns TSV blob with header", async () => {
    const blob = exportFileCells(CELLS, "tsv", "en", "fr")
    const text = await blobText(blob)
    expect(text.startsWith("id\tsource\ttarget")).toBe(true)
  })

  it("csv: returns CSV blob with header", async () => {
    const blob = exportFileCells(CELLS, "csv", "en", "fr")
    const text = await blobText(blob)
    expect(text.startsWith("id,source,target")).toBe(true)
  })

  it("xlf: returns XLIFF blob with language attributes", async () => {
    const blob = exportFileCells(CELLS, "xlf", "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain('source-language="en"')
    expect(text).toContain('target-language="fr"')
  })

  it("tmx: returns TMX blob", async () => {
    const blob = exportFileCells(CELLS, "tmx", "en", "fr")
    const text = await blobText(blob)
    expect(text).toContain('<tmx version="1.4">')
    expect(text).toContain('srclang="en"')
  })

  it("handles empty cell array without throwing", async () => {
    for (const fmt of ["txt", "md", "tsv", "csv", "xlf", "tmx"] as const) {
      const blob = exportFileCells([], fmt, "en", "fr")
      expect(blob.size).toBeGreaterThanOrEqual(0)
    }
  })
})

// ── buildProjectZip ───────────────────────────────────────────────────────

describe("buildProjectZip", () => {
  const FILES: ProjectFileCellsInput[] = [
    { fileId: "f1", fileName: "GEN.SFM", cells: CELLS },
    { fileId: "f2", fileName: "EXO.usfm", cells: [makeCell({ id: "e1", translated: "Exodus text", original: "Exo orig", group: "EXO 1:1" })] },
    { fileId: "f3", fileName: "plain-file", cells: [] },
  ]

  it("produces a valid zip blob", async () => {
    const blob = await buildProjectZip({ files: FILES, format: "tsv", sourceLanguage: "en", targetLanguage: "fr" })
    expect(blob.type).toContain("zip")
    const ab = await blob.arrayBuffer()
    expect(ab.byteLength).toBeGreaterThan(0)
  })

  it("has one entry per input file", async () => {
    const blob = await buildProjectZip({ files: FILES, format: "tsv", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    const names = Object.keys(zip.files)
    expect(names).toHaveLength(3)
  })

  it("names entries with format extension, stripping original extension", async () => {
    const blob = await buildProjectZip({ files: FILES, format: "tsv", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    const names = Object.keys(zip.files)
    // GEN.SFM → GEN.tsv, EXO.usfm → EXO.tsv, plain-file → plain-file.tsv
    expect(names).toContain("GEN.tsv")
    expect(names).toContain("EXO.tsv")
    expect(names).toContain("plain-file.tsv")
  })

  it("entry content matches the per-format exporter output", async () => {
    const blob = await buildProjectZip({ files: FILES, format: "txt", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    const genContent = await zip.file("GEN.txt")!.async("string")
    expect(genContent).toContain("Au commencement")
    expect(genContent).toContain("La terre était informe")
  })

  it("empty file list produces a valid empty zip", async () => {
    const blob = await buildProjectZip({ files: [], format: "tsv", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    expect(Object.keys(zip.files)).toHaveLength(0)
  })

  it("file with zero cells is included and produces valid (possibly empty) export", async () => {
    const blob = await buildProjectZip({ files: FILES, format: "txt", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    // plain-file.txt should exist (zero cells → empty text body)
    expect(zip.file("plain-file.txt")).not.toBeNull()
  })

  it("uses .xlf extension for xliff format", async () => {
    const blob = await buildProjectZip({ files: [FILES[0]], format: "xlf", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    expect(Object.keys(zip.files)).toContain("GEN.xlf")
  })

  it("uses .tmx extension for tmx format", async () => {
    const blob = await buildProjectZip({ files: [FILES[0]], format: "tmx", sourceLanguage: "en", targetLanguage: "fr" })
    const zip = await JSZip.loadAsync(blob)
    expect(Object.keys(zip.files)).toContain("GEN.tmx")
  })
})
