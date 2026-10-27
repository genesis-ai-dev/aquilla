// AQU-2183: the whole-project HTML zip. What a reviewer unzips must be one
// page per USFM book, named so the folder sorts in Bible order, plus an index
// that reaches every book — including the ones that exported nothing.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import {
  HTML_INDEX_ENTRY,
  buildHtmlIndexPage,
  buildHtmlProjectZip,
  planHtmlProjectExport,
  type HtmlProjectFileInput,
} from "./html-project"
import { buildHtmlPage } from "./html"

function makeCell(overrides: Partial<CellData>): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "In the beginning",
    translated: "Au commencement",
    context: "",
    group: "GEN 1:1",
    type: "verse",
    status: "validated",
    validationStatus: "full",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

const NOW = new Date("2026-10-26T15:04:05Z")

/** Genesis, Matthew and Mark — the fixtures the ticket's checklist names, whose
 *  FILE NAMES deliberately do not carry a book code, so the book has to be read
 *  off the rows. */
function genesis(fileId = "f-gen", fileName = "sample.usfm"): HtmlProjectFileInput {
  return {
    fileId,
    fileName,
    cells: [
      makeCell({ id: `${fileId}-1`, fileId, group: "GEN 1:1", translated: "Au commencement" }),
      makeCell({ id: `${fileId}-2`, fileId, group: "GEN 1:2", translated: "La terre était informe" }),
    ],
  }
}

const MATTHEW: HtmlProjectFileInput = {
  fileId: "f-mat",
  fileName: "key-terms.usfm",
  cells: [makeCell({ id: "m1", fileId: "f-mat", group: "MAT 1:1", original: "The book", translated: "Le livre" })],
}

const MARK: HtmlProjectFileInput = {
  fileId: "f-mrk",
  fileName: "parity-mark.usfm",
  cells: [makeCell({ id: "k1", fileId: "f-mrk", group: "MRK 1:1", original: "The beginning", translated: "Le début" })],
}

/** Neither its rows nor its name name a book. */
const NOT_A_BOOK: HtmlProjectFileInput = {
  fileId: "f-doc",
  fileName: "handbook.docx",
  cells: [makeCell({ id: "d1", fileId: "f-doc", group: "", type: "text", original: "Notes", translated: "Notes" })],
}

async function entries(blob: Blob): Promise<string[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return Object.keys(zip.files).sort()
}

async function read(blob: Blob, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const file = zip.file(name)
  if (!file) throw new Error(`${name} is not in the zip`)
  return file.async("string")
}

describe("planHtmlProjectExport", () => {
  it("orders books canonically and names pages by canonical ordinal", () => {
    // Fed out of Bible order on purpose.
    const plan = planHtmlProjectExport([MARK, genesis(), MATTHEW])

    expect(plan.books.map((b) => b.bookCode)).toEqual(["GEN", "MAT", "MRK"])
    expect(plan.books.map((b) => b.pageName)).toEqual(["01-GEN.html", "40-MAT.html", "41-MRK.html"])
    // A two-digit prefix is what makes a file browser's string sort canonical.
    expect(plan.books.map((b) => b.pageName!.slice(0, 2)).every((p) => p.length === 2)).toBe(true)
    expect(plan.skipped).toEqual([])
  })

  it("reads the book off the rows, not the file name", () => {
    // Named for Matthew, but its rows are Mark's: the content wins.
    const misnamed: HtmlProjectFileInput = { ...MARK, fileName: "40-MAT.usfm" }
    expect(planHtmlProjectExport([misnamed]).books[0].bookCode).toBe("MRK")
  })

  it("falls back to the file name when no row carries a reference", () => {
    const byName: HtmlProjectFileInput = {
      fileId: "f-jon",
      fileName: "JON.usfm",
      cells: [makeCell({ id: "j1", fileId: "f-jon", group: "", type: "text", translated: "Jonas" })],
    }
    expect(planHtmlProjectExport([byName]).books[0].bookCode).toBe("JON")
  })

  it("skips files that are not USFM books", () => {
    const plan = planHtmlProjectExport([genesis(), NOT_A_BOOK])

    expect(plan.books.map((b) => b.bookCode)).toEqual(["GEN"])
    expect(plan.skipped).toEqual(["handbook.docx"])
  })

  it("gives two files of the same book distinct page names, in file order", () => {
    const plan = planHtmlProjectExport([genesis("f-gen-a", "sample.usfm"), genesis("f-gen-b", "sample-2.usfm")])

    expect(plan.books.map((b) => b.pageName)).toEqual(["01-GEN.html", "01-GEN-2.html"])
    expect(plan.books.map((b) => b.fileName)).toEqual(["sample.usfm", "sample-2.usfm"])
    expect(plan.books.every((b) => b.duplicate)).toBe(true)
  })

  it("plans no page for a book with nothing to export, but still lists it", () => {
    // What validated-only leaves behind: the file is in the project, every row
    // of it was dropped before the exporter saw it.
    const empty: HtmlProjectFileInput = { ...MATTHEW, cells: [], identityCells: MATTHEW.cells }
    const plan = planHtmlProjectExport([genesis(), empty])

    expect(plan.books.map((b) => b.bookCode)).toEqual(["GEN", "MAT"])
    expect(plan.books.find((b) => b.bookCode === "MAT")!.pageName).toBeNull()
    expect(plan.books.find((b) => b.bookCode === "GEN")!.pageName).toBe("01-GEN.html")
  })
})

describe("buildHtmlIndexPage", () => {
  it("lists books in canonical order, linking only the ones with a page", () => {
    const plan = planHtmlProjectExport([MARK, genesis(), { ...MATTHEW, cells: [], identityCells: MATTHEW.cells }])
    const html = buildHtmlIndexPage(plan.books, { title: "Luke's draft", now: NOW })

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain("<title>Luke&#39;s draft</title>")
    expect(html).toContain('<li><a href="01-GEN.html">Genesis</a></li>')
    expect(html).toContain('<li><a href="41-MRK.html">Mark</a></li>')
    // The empty book is present and plainly marked, with nothing to click.
    expect(html).toContain('<li class="empty">Matthew<span class="empty-note">no verses exported</span></li>')
    expect(html).not.toContain('href="40-MAT.html"')
    // Canonical order on the page itself, not just in the plan.
    expect(html.indexOf("Genesis")).toBeLessThan(html.indexOf("Matthew"))
    expect(html.indexOf("Matthew")).toBeLessThan(html.indexOf(">Mark<"))
    // Same shell and footer as the book pages.
    expect(html).toContain("<style>")
    expect(html).toContain("Exported from Aquilla on 2026-10-26.")
  })

  it("names the file beside a duplicated book so the two entries differ", () => {
    const plan = planHtmlProjectExport([genesis("f-a", "sample.usfm"), genesis("f-b", "sample-2.usfm")])
    const html = buildHtmlIndexPage(plan.books, { now: NOW })

    expect(html).toContain('<a href="01-GEN.html">Genesis <span class="file-note">(sample.usfm)</span></a>')
    expect(html).toContain('<a href="01-GEN-2.html">Genesis <span class="file-note">(sample-2.usfm)</span></a>')
  })

  it("says so when the export was validated-only", () => {
    const plan = planHtmlProjectExport([genesis()])
    const html = buildHtmlIndexPage(plan.books, { validatedOnly: true, now: NOW })
    expect(html).toContain("validated only")
  })
})

describe("buildHtmlProjectZip", () => {
  it("writes index.html plus one page per book, and reports the counts", async () => {
    const result = await buildHtmlProjectZip({
      files: [MARK, genesis(), MATTHEW, NOT_A_BOOK],
      title: "My project",
      now: NOW,
    })

    expect(await entries(result.blob)).toEqual(["01-GEN.html", "40-MAT.html", "41-MRK.html", HTML_INDEX_ENTRY])
    expect(result.booksExported).toBe(3)
    expect(result.filesSkipped).toBe(1)
  })

  it("gives every book page a link back to the index, and the index none", async () => {
    const result = await buildHtmlProjectZip({ files: [genesis()], now: NOW })

    const page = await read(result.blob, "01-GEN.html")
    expect(page).toContain('<nav class="back-link"><a href="index.html">← All books</a></nav>')
    expect(await read(result.blob, HTML_INDEX_ENTRY)).not.toContain('class="back-link"')
  })

  it("writes the same page the single-book export does, apart from the back-link", async () => {
    const file = genesis()
    const result = await buildHtmlProjectZip({ files: [file], lang: "fr", now: NOW })

    const fromZip = await read(result.blob, "01-GEN.html")
    const single = buildHtmlPage(file.cells, { fileName: file.fileName, lang: "fr", now: NOW })
    const backLink = '<nav class="back-link"><a href="index.html">← All books</a></nav>\n'
    expect(fromZip.replace(backLink, "")).toBe(single)
  })

  it("writes no page for a book with nothing to export", async () => {
    const result = await buildHtmlProjectZip({
      files: [genesis(), { ...MATTHEW, cells: [], identityCells: MATTHEW.cells }],
      now: NOW,
    })

    expect(await entries(result.blob)).toEqual(["01-GEN.html", HTML_INDEX_ENTRY])
    // Still counted and indexed — the reader can see Matthew is in the project.
    expect(result.booksExported).toBe(2)
    expect(await read(result.blob, HTML_INDEX_ENTRY)).toContain("Matthew")
  })

  it("keeps both files when the project holds the same book twice", async () => {
    const result = await buildHtmlProjectZip({
      files: [genesis("f-a", "sample.usfm"), genesis("f-b", "sample-2.usfm")],
      now: NOW,
    })

    expect(await entries(result.blob)).toEqual(["01-GEN-2.html", "01-GEN.html", HTML_INDEX_ENTRY])
  })

  it("produces a valid zip with just an index when the project has no books", async () => {
    const result = await buildHtmlProjectZip({ files: [NOT_A_BOOK], now: NOW })

    expect(await entries(result.blob)).toEqual([HTML_INDEX_ENTRY])
    expect(result.booksExported).toBe(0)
    expect(result.filesSkipped).toBe(1)
  })
})
