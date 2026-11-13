// AQU-2552: the Word and PowerPoint exports write a paragraph as its lines in
// order, each line's translation, or its source where it has none. A hidden or
// deleted line contributes nothing; a paragraph leaves the file only when every
// one of its lines is gone. (The Sentence setting cuts a long paragraph into
// several lines, so a paragraph can be partly translated, partly hidden.)
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { exportPptx } from "./pptx"
import { hiddenRoundTripRemovals, scopeRoundTripCells } from "../validation-scope"
import { splitLineOrigin, userLineOrigin } from "@/lib/timeline/user-line-origin"
import type { CellData } from "@/hooks/useCells"

const LINES = ["First line here.", "Second line here.", "Third line here."]
const FRENCH = ["Première ligne ici.", "Deuxième ligne ici.", "Troisième ligne ici."]
const WORD = "word/document.xml"
const SLIDE = "ppt/slides/slide1.xml"

/** Line k (from 0) of a paragraph, located as the importer locates it. A
 *  line typed in the editor carries its HTML too, as every editor save does. */
function lineCell(k: number, at: { memberPath: string; blockPath: string } | null, over: Partial<CellData> = {}): CellData {
  return {
    id: `line-${k}`,
    fileId: "f1",
    original: LINES[k],
    translated: FRENCH[k],
    translatedHtml: `<p>${FRENCH[k]}</p>`,
    context: "",
    group: "g1",
    type: "text",
    status: "validated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    metadata: at
      ? { aquillaImport: { sourceLocator: { kind: "package-block", ...at, segment: k + 1 }, physicalOrder: k + 1 } }
      : null,
    ...over,
  } as CellData
}

/** A line nobody has typed in: no translation, no HTML. */
const UNTRANSLATED = { translated: "", translatedHtml: undefined } as const

/** The cell of the paragraph after, untranslated, on a file imported before locators. */
const legacyNext = () => ({ ...lineCell(0, null), id: "next", group: "g2", original: "Next paragraph.", ...UNTRANSLATED } as CellData)

/** A translation typed and then erased: the editor still saves its empty markup. */
const ERASED = { translated: "", translatedHtml: "<p></p>" } as const

/** Three lines of one paragraph; `untranslated` and `hidden` name lines by index. */
function threeLines(at: { memberPath: string; blockPath: string } | null, { untranslated = [] as number[], hidden = [] as number[] } = {}): CellData[] {
  return LINES.map((_, k) => lineCell(k, at, {
    ...(untranslated.includes(k) ? UNTRANSLATED : {}),
    ...(hidden.includes(k) ? { hidden: true } : {}),
  }))
}

/**
 * The second line cut in two in the editor: the line keeps "Second line" and
 * a new row holds "here.", marked as split off it (as the editor's quote split
 * and the Agent API's SplitCell mark it), with no locator of its own. The
 * piece's translation is given by `piece`; the line's own is "Deuxième ligne".
 */
function withSplitLine(at: { memberPath: string; blockPath: string } | null, piece: Partial<CellData>): CellData[] {
  const [first, second, third] = threeLines(at)
  return [
    first,
    { ...second, original: "Second line", translated: "Deuxième ligne", translatedHtml: "<p>Deuxième ligne</p>" },
    {
      ...lineCell(1, null),
      id: "piece",
      original: "here.",
      group: "",
      metadata: { aquillaOrigin: splitLineOrigin(second.id) },
      ...UNTRANSLATED,
      ...piece,
    },
    third,
  ]
}

// ── Word ─────────────────────────────────────────────────────────────────────

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const wordPara = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

async function docx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(WORD, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

/** Export as the dialog does: hidden lines cleared and handed over as removals. */
async function wordExport(body: string, cells: CellData[], removed: { metadata: Record<string, unknown> | null }[] = []): Promise<string> {
  const result = await exportDocx(await docx(body), scopeRoundTripCells(cells, "current"), {
    removedCells: [...removed, ...hiddenRoundTripRemovals(cells)],
  })
  return (await JSZip.loadAsync(await result.blob.arrayBuffer())).file(WORD)!.async("string")
}

/** Each paragraph's visible text, in order. */
function wordParagraphs(xml: string): string[] {
  return (xml.match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").replace(/\s+/g, " ").trim())
}

/** Each paragraph's visible text, a footnote reference shown as [^id]. */
function wordParagraphsWithNotes(xml: string): string[] {
  return (xml.match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:footnoteReference\b[^>]*w:id="([^"]+)"[^>]*\/>/g)]
      .map((m) => (m[2] !== undefined ? `[^${m[2]}]` : m[1])).join("").replace(/\s+/g, " ").trim())
}

/** A footnote reference run, as Word writes one. */
const noteRef = (id: number) => `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
const NOTES = ["Note one.", "Note two."]
/** The marker the importer puts in a line's source for note k (from 0). */
const noteMarker = (k: number) => `\\f + \\ft ${NOTES[k]}\\f*`

/** A paragraph of the three lines, where line k (from 0, in `noted`) ends
 *  with a reference to note k + 1. */
const footnoted = (noted: number[]) =>
  "<w:p>" + LINES.map((line, k) => `<w:r><w:t xml:space="preserve">${k > 0 ? " " : ""}${line}</w:t></w:r>${noted.includes(k) ? noteRef(k + 1) : ""}`).join("") +
  "</w:p>" + wordPara("Next paragraph.")

const FOOTNOTES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'}>` +
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
  NOTES.map((text, k) => `<w:footnote w:id="${k + 1}"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:footnote>`).join("") +
  `</w:footnotes>`

/** The three lines' cells for `footnoted(noted)`: a noted line's source ends
 *  with its note's marker, as the importer writes it. */
function footnotedLines(noted: number[], options: { untranslated?: number[]; hidden?: number[] } = {}): CellData[] {
  return threeLines(AT_WORD, options).map((cell, k) => (noted.includes(k) ? { ...cell, original: `${LINES[k]}${noteMarker(k)}` } : cell))
}

/** The visible text of note `id` in word/footnotes.xml. */
function noteText(notes: string, id: number): string {
  const note = notes.match(new RegExp(`<w:footnote\\b[^>]*w:id="${id}"[^>]*>([\\s\\S]*?)</w:footnote>`))?.[1] ?? ""
  return [...note.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").trim()
}

/** Export `footnoted(noted)` as the dialog does; the document and the notes. */
async function footnotedExport(noted: number[], cells: CellData[]): Promise<{ body: string; notes: string }> {
  const zip = new JSZip()
  zip.file(WORD, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${footnoted(noted)}</w:body></w:document>`)
  zip.file("word/footnotes.xml", FOOTNOTES_XML)
  const result = await exportDocx(await zip.generateAsync({ type: "arraybuffer" }), scopeRoundTripCells(cells, "current"), {
    removedCells: hiddenRoundTripRemovals(cells),
  })
  const out = await JSZip.loadAsync(await result.blob.arrayBuffer())
  return { body: await out.file(WORD)!.async("string"), notes: await out.file("word/footnotes.xml")!.async("string") }
}

const ONE_PARAGRAPH = wordPara(LINES.join(" ")) + wordPara("Next paragraph.")
const AT_WORD = { memberPath: WORD, blockPath: "w:p[1]" }

describe("Word export — a paragraph partly translated (AQU-2552)", () => {
  it.each([
    ["first", 0, "First line here. Deuxième ligne ici. Troisième ligne ici."],
    ["middle", 1, "Première ligne ici. Second line here. Troisième ligne ici."],
    ["last", 2, "Première ligne ici. Deuxième ligne ici. Third line here."],
  ])("keeps the %s line's own words when it has no translation", async (_name, k, want) => {
    const xml = await wordExport(ONE_PARAGRAPH, threeLines(AT_WORD, { untranslated: [k] }))
    expect(wordParagraphs(xml)).toEqual([want, "Next paragraph."])
  })

  it("writes an unvalidated line's source, never its draft, in a validated-only export", async () => {
    const cells = threeLines(AT_WORD).map((cell, k) => (k === 1 ? { ...cell, status: "unvalidated" } as CellData : cell))
    const result = await exportDocx(await docx(ONE_PARAGRAPH), scopeRoundTripCells(cells, "validated-only"))
    const xml = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file(WORD)!.async("string")
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
  })

  it("keeps the source of a line whose translation was typed and then erased", async () => {
    const cells = threeLines(AT_WORD, { untranslated: [2] }).map((cell, k) => (k === 0 ? { ...cell, ...ERASED } : cell))
    const xml = await wordExport(ONE_PARAGRAPH, cells)
    expect(wordParagraphs(xml)).toEqual(["First line here. Deuxième ligne ici. Third line here.", "Next paragraph."])
  })

  it("leaves the paragraph as it is when its only typed line was erased", async () => {
    const cells = threeLines(AT_WORD, { untranslated: [1, 2] }).map((cell, k) => (k === 0 ? { ...cell, ...ERASED } : cell))
    const result = await exportDocx(await docx(ONE_PARAGRAPH), scopeRoundTripCells(cells, "current"))
    expect(result.injected).toBe(0)
    const xml = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file(WORD)!.async("string")
    expect(xml).toContain(wordPara(LINES.join(" ")))
  })
})

describe("Word export — footnotes in a partly translated paragraph (AQU-2552)", () => {
  it("keeps an untranslated line's footnote as a real footnote, at its place", async () => {
    const { body, notes } = await footnotedExport([1], footnotedLines([1], { untranslated: [1] }))
    expect(body).not.toContain("\\f")
    expect(wordParagraphsWithNotes(body)).toEqual(["Première ligne ici. Second line here.[^2] Troisième ligne ici.", "Next paragraph."])
    expect(noteText(notes, 2)).toBe(NOTES[1])
  })

  it("leaves out a hidden line's footnote and keeps the next line's own", async () => {
    const { body, notes } = await footnotedExport([0, 1], footnotedLines([0, 1], { hidden: [0], untranslated: [1] }))
    expect(body).not.toContain("\\f")
    expect(wordParagraphsWithNotes(body)).toEqual(["Second line here.[^2] Troisième ligne ici.", "Next paragraph."])
    // Neither note takes the other's words.
    expect([noteText(notes, 1), noteText(notes, 2)]).toEqual(NOTES)
  })
})

describe("Word export — a file imported before locators (AQU-2552)", () => {
  // Such a file cannot place a removal, so a hidden line keeps its original
  // text, as the export dialog's note says.
  it("keeps an untranslated line", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, [...threeLines(null, { untranslated: [1] }), legacyNext()])
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
  })

  it("keeps a hidden line's original text in a partly translated paragraph", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, [...threeLines(null, { hidden: [1] }), legacyNext()])
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
  })

  it("leaves an untranslated paragraph with a hidden line as it is", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, [...threeLines(null, { untranslated: [0, 1, 2], hidden: [1] }), legacyNext()])
    expect(xml).toContain(wordPara(LINES.join(" ")))
  })

  it("keeps a split piece in its line's paragraph", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, [...withSplitLine(null, {}), legacyNext()])
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Deuxième ligne here. Troisième ligne ici.", "Next paragraph."])
  })
})

describe("Word export — a line split in the editor (AQU-2552)", () => {
  it("keeps an untranslated piece's words in its place in the paragraph", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, withSplitLine(AT_WORD, {}))
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Deuxième ligne here. Troisième ligne ici.", "Next paragraph."])
  })

  it("writes a translated piece in its place, not as a paragraph of its own", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, withSplitLine(AT_WORD, { translated: "ici.", translatedHtml: "<p>ici.</p>" }))
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Deuxième ligne ici. Troisième ligne ici.", "Next paragraph."])
  })

  it("leaves out a deleted piece, even when no line is translated", async () => {
    const cells = withSplitLine(AT_WORD, {}).map((cell) => (cell.id === "piece" ? cell : { ...cell, ...UNTRANSLATED }))
    const piece = cells.find((cell) => cell.id === "piece")!
    const xml = await wordExport(ONE_PARAGRAPH, cells.filter((cell) => cell !== piece), [{ metadata: piece.metadata ?? null }])
    expect(wordParagraphs(xml)).toEqual(["First line here. Second line Third line here.", "Next paragraph."])
  })

  it("still writes a line a person added on its own as a paragraph after", async () => {
    const added = { ...lineCell(1, null), id: "added", original: "", translated: "Ajoutée.", translatedHtml: "<p>Ajoutée.</p>", metadata: { aquillaOrigin: userLineOrigin() } } as CellData
    const [first, second, third] = threeLines(AT_WORD)
    const xml = await wordExport(ONE_PARAGRAPH, [first, second, added, third])
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Deuxième ligne ici. Troisième ligne ici.", "Ajoutée.", "Next paragraph."])
  })
})

describe("Word export — a hidden or deleted line (AQU-2552)", () => {
  it("leaves out a hidden line and keeps the paragraph's other lines", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, threeLines(AT_WORD, { hidden: [1] }))
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici. Troisième ligne ici.", "Next paragraph."])
  })

  it("leaves out a deleted line, even when no other line is translated", async () => {
    const [first, deleted, last] = threeLines(AT_WORD, { untranslated: [0, 1, 2] })
    const xml = await wordExport(ONE_PARAGRAPH, [first, last], [{ metadata: deleted.metadata ?? null }])
    expect(wordParagraphs(xml)).toEqual(["First line here. Third line here.", "Next paragraph."])
  })

  it("removes the paragraph when every line of it is hidden", async () => {
    const xml = await wordExport(ONE_PARAGRAPH, threeLines(AT_WORD, { hidden: [0, 1, 2] }))
    expect(wordParagraphs(xml)).toEqual(["Next paragraph."])
  })

  it("empties a table cell's only paragraph when every line is hidden, rather than leave the cell with none", async () => {
    const table = `<w:tbl><w:tr><w:tc><w:tcPr/><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">${LINES.join(" ")}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>${wordPara("After.")}`
    const xml = await wordExport(table, threeLines(AT_WORD, { hidden: [0, 1, 2] }))
    expect(xml).toContain('<w:tc><w:tcPr/><w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:tc>')
    expect(wordParagraphs(xml)).toEqual(["", "After."])
  })

  it("keeps the only paragraph of a table cell when one of its lines is hidden", async () => {
    const table = `<w:tbl><w:tr><w:tc>${wordPara(LINES.slice(0, 2).join(" "))}</w:tc></w:tr></w:tbl>${wordPara("After.")}`
    const cells = threeLines(AT_WORD, { hidden: [1] }).slice(0, 2)
    const xml = await wordExport(table, cells)
    expect(xml).toMatch(/<w:tc><w:p>[\s\S]*Première ligne ici\.[\s\S]*<\/w:p><\/w:tc>/)
    expect(wordParagraphs(xml)).toEqual(["Première ligne ici.", "After."])
  })
})

// ── PowerPoint ───────────────────────────────────────────────────────────────

async function pptx(paragraphText: string): Promise<ArrayBuffer> {
  return deck(`<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${paragraphText}</a:t></a:r></a:p><a:p><a:r><a:t>Next paragraph.</a:t></a:r></a:p></p:txBody></p:sp>`)
}

/** A one-slide deck whose shape tree is `spTree`. */
async function deck(spTree: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    SLIDE,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${spTree}</p:spTree></p:cSld></p:sld>`,
  )
  return zip.generateAsync({ type: "arraybuffer" })
}

/** Export a deck as the dialog does; the slide's XML. */
async function slideXml(bytes: ArrayBuffer, cells: CellData[], removed: { metadata: Record<string, unknown> | null }[] = []): Promise<string> {
  const result = await exportPptx(bytes, scopeRoundTripCells(cells, "current"), {
    removedCells: [...removed, ...hiddenRoundTripRemovals(cells)],
  })
  return (await JSZip.loadAsync(await result.blob.arrayBuffer())).file(SLIDE)!.async("string")
}

async function slideParagraphs(cells: CellData[], mode: "current" | "validated-only" = "current"): Promise<string[]> {
  const result = await exportPptx(await pptx(LINES.join(" ")), scopeRoundTripCells(cells, mode), {
    removedCells: hiddenRoundTripRemovals(cells),
  })
  const xml = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file(SLIDE)!.async("string")
  return (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []).map((p) =>
    [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("").replace(/\s+/g, " ").trim())
}

const AT_SLIDE = { memberPath: SLIDE, blockPath: "p:sp[1]/p:txBody/a:p[1]" }

describe("PowerPoint export — a paragraph partly translated (AQU-2552)", () => {
  it.each([
    ["first", 0, "First line here. Deuxième ligne ici. Troisième ligne ici."],
    ["middle", 1, "Première ligne ici. Second line here. Troisième ligne ici."],
    ["last", 2, "Première ligne ici. Deuxième ligne ici. Third line here."],
  ])("keeps the %s line's own words when it has no translation", async (_name, k, want) => {
    expect(await slideParagraphs(threeLines(AT_SLIDE, { untranslated: [k] }))).toEqual([want, "Next paragraph."])
  })

  it("writes an unvalidated line's source, never its draft, in a validated-only export", async () => {
    const cells = threeLines(AT_SLIDE).map((cell, k) => (k === 1 ? { ...cell, status: "unvalidated" } as CellData : cell))
    expect(await slideParagraphs(cells, "validated-only")).toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
  })

  it("keeps the source of a line whose translation was typed and then erased", async () => {
    const cells = threeLines(AT_SLIDE, { untranslated: [2] }).map((cell, k) => (k === 0 ? { ...cell, ...ERASED } : cell))
    expect(await slideParagraphs(cells)).toEqual(["First line here. Deuxième ligne ici. Third line here.", "Next paragraph."])
  })

  it("leaves the paragraph as it is when its only typed line was erased", async () => {
    const cells = threeLines(AT_SLIDE, { untranslated: [1, 2] }).map((cell, k) => (k === 0 ? { ...cell, ...ERASED } : cell))
    expect(await slideParagraphs(cells)).toEqual([LINES.join(" "), "Next paragraph."])
  })

  it("keeps an untranslated split piece's words in its place in the paragraph", async () => {
    expect(await slideParagraphs(withSplitLine(AT_SLIDE, {}))).toEqual(["Première ligne ici. Deuxième ligne here. Troisième ligne ici.", "Next paragraph."])
  })

  it("writes a translated split piece in its place, not as a paragraph of its own", async () => {
    expect(await slideParagraphs(withSplitLine(AT_SLIDE, { translated: "ici.", translatedHtml: "<p>ici.</p>" })))
      .toEqual(["Première ligne ici. Deuxième ligne ici. Troisième ligne ici.", "Next paragraph."])
  })

  it("keeps a split piece in its line's paragraph on a deck imported before locators", async () => {
    expect(await slideParagraphs([...withSplitLine(null, {}), legacyNext()])).toEqual(["Première ligne ici. Deuxième ligne here. Troisième ligne ici.", "Next paragraph."])
  })

  it("keeps an untranslated line on a deck imported before locators too", async () => {
    // No locators: each group fills the next paragraph with text, in order.
    const cells = [...threeLines(null, { untranslated: [1] }), legacyNext()]
    expect(await slideParagraphs(cells)).toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
  })

  it("keeps a hidden line's original text on a deck imported before locators", async () => {
    // Such a deck cannot place a removal, as the export dialog's note says.
    expect(await slideParagraphs([...threeLines(null, { hidden: [1] }), legacyNext()]))
      .toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
    expect(await slideParagraphs([...threeLines(null, { untranslated: [0, 1, 2], hidden: [1] }), legacyNext()]))
      .toEqual([LINES.join(" "), "Next paragraph."])
  })

  it("leaves out a hidden line and keeps the paragraph's other lines", async () => {
    expect(await slideParagraphs(threeLines(AT_SLIDE, { hidden: [1] }))).toEqual(["Première ligne ici. Troisième ligne ici.", "Next paragraph."])
  })

  it("leaves out a deleted line, even when no other line is translated", async () => {
    const [first, deleted, last] = threeLines(AT_SLIDE, { untranslated: [0, 1, 2] })
    const xml = await slideXml(await pptx(LINES.join(" ")), [first, last], [{ metadata: deleted.metadata ?? null }])
    expect(xml).toContain("<a:p><a:r><a:t>First line here. Third line here.</a:t></a:r></a:p>")
  })

  it("removes the paragraph when every line of it is hidden", async () => {
    expect(await slideParagraphs(threeLines(AT_SLIDE, { hidden: [0, 1, 2] }))).toEqual(["Next paragraph."])
  })

  it("empties a text box's only paragraph when every line is hidden, rather than leave the box with none", async () => {
    const xml = await slideXml(
      await deck(`<p:sp><p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US"/><a:t>${LINES.join(" ")}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`),
      threeLines(AT_SLIDE, { hidden: [0, 1, 2] }),
    )
    expect(xml).toContain('<p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:endParaRPr lang="en-US"/></a:p></p:txBody>')
  })

  it("empties a text box's only paragraph when every line is deleted", async () => {
    const lines = threeLines(AT_SLIDE)
    const xml = await slideXml(
      await deck(`<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${LINES.join(" ")}</a:t></a:r></a:p></p:txBody></p:sp>`),
      [],
      lines.map((cell) => ({ metadata: cell.metadata ?? null })),
    )
    expect(xml).toContain("<p:txBody><a:bodyPr/><a:p/></p:txBody>")
  })

  it("empties a table cell's only paragraph when every line is hidden", async () => {
    const at = { memberPath: SLIDE, blockPath: "p:graphicFrame[1]/a:tbl/a:tr[1]/a:tc[1]/a:txBody/a:p[1]" }
    const xml = await slideXml(
      await deck(`<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${LINES.join(" ")}</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`),
      threeLines(at, { hidden: [0, 1, 2] }),
    )
    expect(xml).toContain("<a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc>")
  })
})
