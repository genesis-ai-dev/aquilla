// AQU-2539 — the Word exporter finds, reads and rebuilds paragraphs the
// importer's way. Every fixture is a small synthetic reproduction of a shape
// from a partner's real file; every export is parsed as XML.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { docxPartsToStrings } from "@/lib/parsers/docx"
import { assertWellFormedXml } from "@/lib/parsers/xml-lite"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import {
  complexField,
  documentXml,
  footnoteRefRun,
  footnotesXml,
  para,
  pictureRun,
  run,
  textBoxRun,
} from "@/lib/parsers/__fixtures__/docx-structures"

async function makeDocx(body: string, footnotes?: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("word/document.xml", documentXml(body))
  if (footnotes) zip.file("word/footnotes.xml", footnotes)
  return zip.generateAsync({ type: "arraybuffer" })
}

function cellAt(paragraph: number, translated: string, extra: Partial<CellData> = {}, segment = 1): CellData {
  return {
    id: `c${paragraph}-${segment}`,
    fileId: "f",
    original: "",
    translated,
    context: "Paragraph",
    group: `g${paragraph}`,
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    metadata: {
      aquillaImport: {
        sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: `w:p[${paragraph}]`, segment },
        physicalOrder: paragraph * 100 + segment,
      },
    },
    ...extra,
  } as CellData
}

/** Cells the importer makes, each translated by `translate`. */
function importedCells(strings: TranslatableString[], translate: (s: TranslatableString) => string): CellData[] {
  const seen = new Map<string, number>()
  return strings.map((s) => {
    const bp = s.sourceLocation!.blockPath
    const n = Number(/\d+/.exec(bp)![0])
    const k = (seen.get(bp) ?? 0) + 1
    seen.set(bp, k)
    return cellAt(n, translate(s), { original: s.original }, k)
  })
}

async function exportedXml(body: string, cells: CellData[], footnotes?: string): Promise<{ xml: string; result: Awaited<ReturnType<typeof exportDocx>> }> {
  const result = await exportDocx(await makeDocx(body, footnotes), cells)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml")!.async("string")
  expectWellFormed(xml)
  return { xml, result }
}

/** Two independent checks: happy-dom's XML parser and the exporter's guard. */
function expectWellFormed(xml: string): void {
  const doc = new DOMParser().parseFromString(xml, "application/xml")
  expect(doc.getElementsByTagName("parsererror").length).toBe(0)
  expect(() => assertWellFormedXml(xml)).not.toThrow()
}

const paragraphs = (xml: string) => (xml.match(/<w:p[\s/>]/g) ?? []).length

describe("exportDocx — paragraphs nested in text boxes (AQU-2539)", () => {
  const body =
    para(run("Heading text"), "Heading1") +
    para(run("Holder ") + textBoxRun(para(run("Box caption"), "Caption")) + run("words")) +
    para(run("Next heading"), "Heading2") +
    para(run("Body after"))

  it("writes every translation into its own paragraph, the text box and its copy included", async () => {
    // w:p[1] heading, [2] holder, [3] box (Choice), [4] box copy (Fallback), [5] heading, [6] body
    const strings = docxPartsToStrings({ documentXml: documentXml(body) })
    expect(strings.map((s) => s.sourceLocation?.blockPath)).toEqual(["w:p[1]", "w:p[2]", "w:p[3]", "w:p[5]", "w:p[6]"])
    const cells = importedCells(strings, (s) => `FR ${s.original}`)
    const { xml } = await exportedXml(body, cells)
    expect(paragraphs(xml)).toBe(6)
    const after = docxPartsToStrings({ documentXml: xml })
    expect(after.map((s) => [s.sourceLocation?.blockPath, s.original])).toEqual([
      ["w:p[1]", "FR Heading text"],
      ["w:p[2]", "FR Holder words"],
      ["w:p[3]", "FR Box caption"],
      ["w:p[5]", "FR Next heading"],
      ["w:p[6]", "FR Body after"],
    ])
    // The old-reader copy carries the same translation.
    expect(xml.match(/FR Box caption/g)).toHaveLength(2)
  })

  it("exports an OLD import without shifting: swallowed text and copy cells are ignored", async () => {
    // Before AQU-2539 the importer gave w:p[2] the box's words too, and gave
    // the Fallback copy (w:p[4]) its own cell.
    const cells = [
      cellAt(1, "Titre"),
      cellAt(2, "Porteur Légende Légende mots"),
      cellAt(3, "Légende"),
      cellAt(4, "Légende (copie)"),
      cellAt(5, "Titre suivant"),
      cellAt(6, "Corps"),
    ]
    const { xml } = await exportedXml(body, cells)
    const after = docxPartsToStrings({ documentXml: xml }).map((s) => s.original)
    expect(after).toEqual(["Titre", "Porteur Légende Légende mots", "Légende", "Titre suivant", "Corps"])
    expect(xml).not.toContain("Légende (copie)")
  })

  it("leaves a paragraph that only holds a text box alone, even when an old cell targets it", async () => {
    const holderOnly = para(textBoxRun(para(run("Caption"), "Caption")) + pictureRun, "Caption") + para(run("Next"))
    const { xml } = await exportedXml(holderOnly, [cellAt(1, "Caption Caption (old swallowed)"), cellAt(2, "Légende"), cellAt(4, "Suivant")])
    expect(xml).not.toContain("old swallowed")
    expect(xml).toContain("Légende")
    expect(xml).toContain("<w:drawing><wp:inline>")
  })
})

describe("exportDocx — what is not text is kept (AQU-2539)", () => {
  it("keeps pictures, page breaks, bookmarks and field codes by the one placement rule", async () => {
    const body = para(
      `<w:bookmarkStart w:id="1" w:name="_Toc1"/>` +
        `<w:r><w:br w:type="page"/></w:r>` +
        run("Figure ") +
        complexField("SEQ Figure \\* ARABIC", "1") +
        run(": the caption") +
        pictureRun +
        `<w:bookmarkEnd w:id="1"/>`,
    )
    const { xml } = await exportedXml(body, [cellAt(1, "Figure 1 : la légende")])
    const inner = xml.slice(xml.indexOf("<w:p>"), xml.indexOf("</w:p>"))
    // Before the first word: the bookmark start and the page break stay in front.
    expect(inner.indexOf('w:name="_Toc1"')).toBeLessThan(inner.indexOf("Figure 1 : la légende"))
    expect(inner.indexOf('w:type="page"')).toBeLessThan(inner.indexOf("Figure 1 : la légende"))
    // Everything else follows the translation, in its original order.
    for (const kept of ['w:fldCharType="begin"', "SEQ Figure", 'w:fldCharType="end"', "<w:drawing>", "<w:bookmarkEnd"]) {
      expect(inner.indexOf(kept)).toBeGreaterThan(inner.indexOf("la légende"))
    }
    expect(inner).not.toContain("the caption")
  })

  it("writes tabs and line breaks back as Word's own elements", async () => {
    const body = para(`<w:r><w:t>ASV</w:t><w:tab/><w:t>American Standard Version</w:t></w:r>`)
    const strings = docxPartsToStrings({ documentXml: documentXml(body) })
    expect(strings[0].original).toBe("ASV\tAmerican Standard Version")
    const { xml } = await exportedXml(body, importedCells(strings, () => "ASV\tVersion standard\naméricaine"))
    expect(xml).toContain('<w:t xml:space="preserve">ASV</w:t><w:tab/><w:t xml:space="preserve">Version standard</w:t><w:br/><w:t xml:space="preserve">américaine</w:t>')
  })

  it("keeps a tab before the first word where it is", async () => {
    const body = para(`<w:r><w:tab/><w:t>How did it come about?</w:t></w:r>`, "Heading2")
    const { xml } = await exportedXml(body, [cellAt(1, "Comment est-ce arrivé ?")])
    expect(xml).toMatch(/<w:r><w:tab\/><\/w:r><w:r><w:t xml:space="preserve">Comment/)
  })

  it("puts a footnote reference where its marker is, and never writes the marker text", async () => {
    const body = para(run("Leningradensis") + footnoteRefRun(1) + run(", and more."))
    const notes = footnotesXml({ 1: "A note." })
    const strings = docxPartsToStrings({ documentXml: documentXml(body), footnotesXml: notes })
    expect(strings[0].original).toBe("Leningradensis\\f + \\ft A note.\\f*, and more.")
    const cells = importedCells(strings, () => "Le Leningradensis\\f + \\ft Une note.\\f*, et plus.")
    const { xml } = await exportedXml(body, cells, notes)
    expect(xml).not.toContain("\\f")
    expect(xml).toMatch(/Le Leningradensis<\/w:t><\/w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteReference w:id="1"\/><\/w:r><w:r><w:t xml:space="preserve">, et plus\./)
  })

  it("keeps a footnote reference whose marker the translation lost, after the text", async () => {
    const body = para(run("Text") + footnoteRefRun(1) + run(" end."))
    const notes = footnotesXml({ 1: "A note." })
    const { xml } = await exportedXml(body, [cellAt(1, "Texte fin.")], notes)
    expect(xml.indexOf('w:footnoteReference w:id="1"')).toBeGreaterThan(xml.indexOf("Texte fin."))
  })

  it("writes a translation into the link that holds the whole paragraph", async () => {
    const body = para(
      complexField('TOC \\o "1-3"', "").replace(run(""), "").replace(`<w:r><w:fldChar w:fldCharType="end"/></w:r>`, "") +
        `<w:hyperlink w:anchor="_Toc1" w:history="1">${run("List of Figures")}<w:r><w:tab/></w:r>${complexField("PAGEREF _Toc1 \\h", "5")}</w:hyperlink>`,
      "TOC1",
    )
    const { xml } = await exportedXml(body, [cellAt(1, "Liste des figures\t5")])
    expect(xml).toMatch(/<w:hyperlink w:anchor="_Toc1" w:history="1"><w:r><w:t xml:space="preserve">Liste des figures<\/w:t><w:tab\/>/)
    expect(xml).toContain("PAGEREF _Toc1")
    expect(xml.match(/<w:fldChar /g)).toHaveLength(5)
  })
})

describe("exportDocx — translation text (AQU-2539)", () => {
  it("writes a plain translation as text, never as markup", async () => {
    const { xml } = await exportedXml(para(run("Use the bold toggle.")), [cellAt(1, "Use the <b>bold</b> toggle.")])
    expect(xml).toContain("Use the &lt;b&gt;bold&lt;/b&gt; toggle.")
  })

  it("writes every segment when only some of them have editor HTML", async () => {
    const cells = [
      cellAt(1, "Première phrase.", { translatedHtml: "<p><strong>Première</strong> phrase.</p>" }, 1),
      cellAt(1, "Deuxième phrase.", {}, 2),
    ]
    const { xml } = await exportedXml(para(run("First sentence. Second sentence.")), cells)
    expect(xml).toContain("Deuxième phrase.")
    expect(xml).toMatch(/<w:b\/><\/w:rPr><w:t xml:space="preserve">Première<\/w:t>/)
  })

  it("reads the editor's line break and footnote atom from translatedHtml", async () => {
    const body = para(run("One") + footnoteRefRun(1) + run(" two"))
    const notes = footnotesXml({ 1: "N." })
    const html = `<p>Un<span data-usfm-footnote="\\f + \\ft N.\\f*" class="usfm-footnote-marker"></span><br>deux</p>`
    const { xml } = await exportedXml(body, [cellAt(1, "Un\\f + \\ft N.\\f*\ndeux", { translatedHtml: html })], notes)
    expect(xml).toMatch(/Un<\/w:t><\/w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/>/)
    expect(xml).toContain("<w:br/>")
    expect(xml).not.toContain("\\f")
  })

  it("leaves untranslated paragraphs byte-identical", async () => {
    const untouched = para(run("Keep me ") + pictureRun + `<w:proofErr w:type="spellStart"/>` + run("exactly"))
    const { xml } = await exportedXml(para(run("Translate me")) + untouched, [cellAt(1, "Traduis-moi")])
    expect(xml).toContain(untouched)
  })
})
