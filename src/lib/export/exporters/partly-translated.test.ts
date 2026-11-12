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
import type { CellData } from "@/hooks/useCells"

const LINES = ["First line here.", "Second line here.", "Third line here."]
const FRENCH = ["Première ligne ici.", "Deuxième ligne ici.", "Troisième ligne ici."]
const WORD = "word/document.xml"
const SLIDE = "ppt/slides/slide1.xml"

/** Line k (from 0) of a paragraph, located as the importer locates it. */
function lineCell(k: number, at: { memberPath: string; blockPath: string } | null, over: Partial<CellData> = {}): CellData {
  return {
    id: `line-${k}`,
    fileId: "f1",
    original: LINES[k],
    translated: FRENCH[k],
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

/** Three lines of one paragraph; `untranslated` and `hidden` name lines by index. */
function threeLines(at: { memberPath: string; blockPath: string } | null, { untranslated = [] as number[], hidden = [] as number[] } = {}): CellData[] {
  return LINES.map((_, k) => lineCell(k, at, {
    ...(untranslated.includes(k) ? { translated: "" } : {}),
    ...(hidden.includes(k) ? { hidden: true } : {}),
  }))
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
  const zip = new JSZip()
  zip.file(
    SLIDE,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${paragraphText}</a:t></a:r></a:p><a:p><a:r><a:t>Next paragraph.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  )
  return zip.generateAsync({ type: "arraybuffer" })
}

async function slideParagraphs(cells: CellData[]): Promise<string[]> {
  const result = await exportPptx(await pptx(LINES.join(" ")), scopeRoundTripCells(cells, "current"), {
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

  it("keeps an untranslated line on a deck imported before locators too", async () => {
    // No locators: each group fills the next paragraph with text, in order.
    const cells = [...threeLines(null, { untranslated: [1] }), { ...lineCell(0, null), id: "next", group: "g2", original: "Next paragraph.", translated: "" } as CellData]
    expect(await slideParagraphs(cells)).toEqual(["Première ligne ici. Second line here. Troisième ligne ici.", "Next paragraph."])
  })

  it("leaves out a hidden line and keeps the paragraph's other lines", async () => {
    expect(await slideParagraphs(threeLines(AT_SLIDE, { hidden: [1] }))).toEqual(["Première ligne ici. Troisième ligne ici.", "Next paragraph."])
  })
})
