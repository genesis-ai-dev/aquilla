// AQU-2539 — the Word exporter finds, reads and rebuilds paragraphs the
// importer's way. Every fixture is a small synthetic reproduction of a shape
// from a partner's real file; every export is parsed as XML.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { scopeRoundTripCells } from "../validation-scope"
import { docxPartsToStrings } from "@/lib/parsers/docx"
import { assertWellFormedXml } from "@/lib/parsers/xml-lite"
import { structuralProblems } from "./__fixtures__/docx-structure-check"
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
  const outNotes = await zip.file("word/footnotes.xml")?.async("string")
  expectWellFormed(xml)
  expectNoNewStructuralProblems(documentXml(body), xml, footnotes, outNotes)
  return { xml, result }
}

/** The export adds no structural problem its source did not have (Word's
 *  needs beyond well-formed XML: see __fixtures__/docx-structure-check.ts). */
function expectNoNewStructuralProblems(sourceXml: string, exportXml: string, sourceNotes?: string, exportNotes?: string): void {
  const count = (list: string[]) => list.reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map<string, number>())
  const before = count(structuralProblems(sourceXml, sourceNotes))
  const added = structuralProblems(exportXml, exportNotes).filter((p) => {
    const left = before.get(p) ?? 0
    if (left > 0) {
      before.set(p, left - 1)
      return false
    }
    return true
  })
  expect(added).toEqual([])
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

  it("exports an OLD import without shifting: a copy's cell gives way to its box's own, a swallowed-text cell leaves its paragraph alone", async () => {
    // Before AQU-2539 the importer gave w:p[2] the box's words too (Choice and
    // Fallback), and gave the Fallback copy (w:p[4]) its own cell.
    const cells = [
      cellAt(1, "Titre", { original: "Heading text" }),
      cellAt(2, "Porteur Légende Légende mots", { original: "Holder Box captionBox captionwords" }),
      cellAt(3, "Légende", { original: "Box caption" }),
      cellAt(4, "Légende (copie)", { original: "Box caption" }),
      cellAt(5, "Titre suivant", { original: "Next heading" }),
      cellAt(6, "Corps", { original: "Body after" }),
    ]
    const { xml, result } = await exportedXml(body, cells)
    const after = docxPartsToStrings({ documentXml: xml }).map((s) => s.original)
    // w:p[2] keeps its own words; its box is translated by its own cell.
    expect(after).toEqual(["Titre", "Holder words", "Légende", "Titre suivant", "Corps"])
    expect(xml).not.toContain("Légende (copie)")
    expect(xml).not.toContain("Porteur")
    expect(result.fidelity.staleTextBoxHolders).toBe(1)
    expect(result.warnings.map((w) => w.detail)).toContain(
      "imported before text boxes were read separately; re-import the file to translate this paragraph",
    )
  })

  it("still writes a paragraph holding a text box when its cell holds only its own words", async () => {
    const cells = [cellAt(2, "Porteur mots", { original: "Holder words (edited)" })]
    const { xml } = await exportedXml(body, cells)
    expect(docxPartsToStrings({ documentXml: xml }).map((s) => s.original)).toContain("Porteur mots")
  })

  it("writes a fresh cell even when the paragraph's own words repeat its text box's words", async () => {
    const repeat = para(run("Box caption, as the box says ") + textBoxRun(para(run("Box caption"))))
    const strings = docxPartsToStrings({ documentXml: documentXml(repeat) })
    const { xml, result } = await exportedXml(repeat, importedCells(strings, (s) => `FR ${s.original}`))
    expect(result.fidelity.staleTextBoxHolders).toBe(0)
    expect(docxPartsToStrings({ documentXml: xml }).map((s) => s.original)).toEqual(["FR Box caption, as the box says", "FR Box caption"])
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
  it("keeps pictures, page breaks and bookmarks by the one placement rule", async () => {
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
    const firstWord = inner.indexOf(">Figure ")
    // Before the first word: the bookmark start and the page break stay in front.
    expect(inner.indexOf('w:name="_Toc1"')).toBeLessThan(firstWord)
    expect(inner.indexOf('w:type="page"')).toBeLessThan(firstWord)
    // Everything else follows the translation, in its original order.
    expect(inner.indexOf("<w:drawing>")).toBeGreaterThan(inner.indexOf("la légende"))
    expect(inner.indexOf("<w:bookmarkEnd")).toBeGreaterThan(inner.indexOf("<w:drawing>"))
    expect(inner).not.toContain("the caption")
  })

  it("rebuilds a field around its result when the translation keeps that text", async () => {
    const field = complexField("SEQ Figure \\* ARABIC", "1")
    const body = para(run("Figure ") + field + run(": the caption"))
    const { xml } = await exportedXml(body, [cellAt(1, "Figure 1 : la légende")])
    // The whole field, result included, byte for byte where "1" is.
    expect(xml).toContain(`<w:t xml:space="preserve">Figure </w:t></w:r>${field}<w:r><w:t xml:space="preserve"> : la légende</w:t>`)
  })

  it("keeps a field's code with an empty result when its result is not in the translation", async () => {
    const body = para(run("See page ") + complexField("PAGEREF _Ref1 \\h", "12") + run(" for more."))
    const { xml } = await exportedXml(body, [cellAt(1, "Voir plus loin.")])
    expect(xml).toMatch(/Voir plus loin\.<\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:instrText[^>]*> PAGEREF _Ref1 \\h <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:fldChar w:fldCharType="end"\/><\/w:r>/)
    expect(xml).not.toContain(">12<")
  })

  it("rebuilds a simple field around its result, or keeps it emptied", async () => {
    const simple = `<w:fldSimple w:instr=" SEQ Figure \\* ARABIC ">${run("3")}</w:fldSimple>`
    const kept = await exportedXml(para(run("Figure ") + simple + run(": Meaning")), [cellAt(1, "Figure 3 : Sens")])
    expect(kept.xml).toContain(`Figure </w:t></w:r>${simple}<w:r><w:t xml:space="preserve"> : Sens</w:t>`)
    const emptied = await exportedXml(para(run("Figure ") + simple + run(": Meaning")), [cellAt(1, "Figure trois : Sens")])
    expect(emptied.xml).toContain(`Figure trois : Sens</w:t></w:r><w:fldSimple w:instr=" SEQ Figure \\* ARABIC "></w:fldSimple>`)
  })

  it("rebuilds a link around its text when the translation keeps it, and drops it otherwise", async () => {
    const link = `<w:hyperlink r:id="rId9" w:history="1">${run("training@twftw.org", '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>')}</w:hyperlink>`
    const body = para(run("Email: ") + link)
    const kept = await exportedXml(body, [cellAt(1, "Courriel : training@twftw.org")])
    expect(kept.xml).toContain(`Courriel : </w:t></w:r>${link}`)
    const lost = await exportedXml(para(run("See ") + `<w:hyperlink r:id="rId9">${run("this page")}</w:hyperlink>`), [cellAt(1, "Voir cette page")])
    expect(lost.xml).not.toContain("<w:hyperlink")
    expect(lost.xml).toContain("Voir cette page")
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

describe("exportDocx — the look of a translated paragraph (AQU-2539)", () => {
  const B = "<w:rPr><w:b/></w:rPr>"
  const SZ = '<w:rPr><w:sz w:val="22"/></w:rPr>'

  it("takes the look of most of the plain text, not of a bold first word", async () => {
    const body = para(run("Term:", '<w:rPr><w:b/><w:sz w:val="22"/></w:rPr>') + run(" the definition of the term", SZ))
    const { xml } = await exportedXml(body, [cellAt(1, "Terme : la définition du terme")])
    expect(xml).toContain(`<w:r>${SZ}<w:t xml:space="preserve">Terme : la définition du terme</w:t></w:r>`)
    expect(xml).not.toContain("<w:b/>")
  })

  it("keeps the translator's own bold on top of that look", async () => {
    const body = para(run("Term:", '<w:rPr><w:b/><w:sz w:val="22"/></w:rPr>') + run(" the definition", SZ))
    const html = "<p><strong>Terme :</strong> la définition</p>"
    const { xml } = await exportedXml(body, [cellAt(1, "Terme : la définition", { translatedHtml: html })])
    expect(xml).toContain('<w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">Terme :</w:t></w:r>')
    expect(xml).toContain(`<w:r>${SZ}<w:t xml:space="preserve"> la définition</w:t></w:r>`)
  })

  it("stays bold when every word of the source is bold", async () => {
    const { xml } = await exportedXml(para(run("ALL", B) + run(" BOLD", B), "Heading1"), [cellAt(1, "TOUT GRAS")])
    expect(xml).toContain(`<w:r>${B}<w:t xml:space="preserve">TOUT GRAS</w:t></w:r>`)
  })
})

describe("exportDocx — hidden text (AQU-2539)", () => {
  const V = "<w:rPr><w:vanish/></w:rPr>"

  it("leaves a wholly hidden paragraph byte-identical even when an old import translated it", async () => {
    const hidden = para(run("Wikipedia contributors. (n.d.).", V) + run(" Retrieved.", V))
    const { xml } = await exportedXml(para(run("Body")) + hidden, [cellAt(1, "Corps"), cellAt(2, "Contributeurs de Wikipédia.")])
    expect(xml).toContain(hidden)
    expect(xml).not.toContain("Contributeurs")
  })

  it("keeps hidden runs inside a translated paragraph verbatim, by the same placement rule", async () => {
    const note = run("[do not translate]", V)
    const { xml } = await exportedXml(para(run("Visible ") + note + run("words")), [cellAt(1, "Mots visibles")])
    expect(xml).toMatch(/Mots visibles<\/w:t><\/w:r><w:r><w:rPr><w:vanish\/><\/w:rPr><w:t xml:space="preserve">\[do not translate\]/)
  })
})

describe("exportDocx — unchanged text keeps its own look (AQU-2539)", () => {
  const HEB_A = '<w:rPr><w:rFonts w:ascii="SBL Hebrew" w:cs="SBL Hebrew"/><w:rtl/><w:lang w:bidi="he-IL"/></w:rPr>'
  const HEB_B = '<w:rPr><w:rFonts w:ascii="SBL Hebrew" w:cs="SBL Hebrew"/><w:rtl/><w:sz w:val="26"/><w:lang w:bidi="he-IL"/></w:rPr>'
  const GREEK = '<w:rPr><w:rFonts w:ascii="SBL Greek"/><w:i/></w:rPr>'
  const SUP = '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'

  it("writes a Hebrew word split over several runs back with each run's own look", async () => {
    const body = para(run("The word ") + run("ש", HEB_A) + run("ָּׁ", HEB_B) + run("נה", HEB_A) + run(" means year."))
    const { xml } = await exportedXml(body, [cellAt(1, "Le mot שָּׁנה signifie année.")])
    expect(xml).toContain(
      `<w:r><w:t xml:space="preserve">Le mot </w:t></w:r><w:r>${HEB_A}<w:t xml:space="preserve">ש</w:t></w:r>` +
        `<w:r>${HEB_B}<w:t xml:space="preserve">ָּׁ</w:t></w:r><w:r>${HEB_A}<w:t xml:space="preserve">נה</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve"> signifie année.</w:t></w:r>`,
    )
  })

  it("joins Greek words in their own look across the spaces between them", async () => {
    const body = para(run("He reads ") + run("τον", GREEK) + run(" ") + run("υιον", GREEK) + run(" here."))
    const { xml } = await exportedXml(body, [cellAt(1, "Il lit τον υιον ici.")])
    expect(xml).toContain(`<w:r>${GREEK}<w:t xml:space="preserve">τον</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r>${GREEK}<w:t xml:space="preserve">υιον</w:t></w:r>`)
  })

  it("does not let a short Latin stretch grab a word of the translation", async () => {
    const body = para(run("the 4") + run("th", SUP) + run(" century, Codex a") + run("a", SUP))
    const { xml } = await exportedXml(body, [cellAt(1, "le IVe siècle, il a th")])
    expect(xml).not.toContain("superscript")
  })

  it("keeps a look only on whole words and in source order", async () => {
    const MT = '<w:rPr><w:smallCaps/></w:rPr>'
    const body = para(run("The ") + run("LXX", MT) + run(" and the ") + run("MT", '<w:rPr><w:caps/></w:rPr>') + run(" differ."))
    // "LXXI" is not the word LXX; the real one comes later.
    const { xml } = await exportedXml(body, [cellAt(1, "LXXI : la LXX et le TM diffèrent.")])
    expect(xml).toContain(`la </w:t></w:r><w:r>${MT}<w:t xml:space="preserve">LXX</w:t></w:r>`)
    expect(xml).toContain('<w:t xml:space="preserve">LXXI : la </w:t>')
  })
})

describe("exportDocx — the target language (AQU-2539)", () => {
  const NB = " "
  const HEB = '<w:rPr><w:rFonts w:cs="SBL Hebrew"/><w:rtl/><w:lang w:val="en-US" w:bidi="he-IL"/></w:rPr>'
  const EN = '<w:rPr><w:sz w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>'

  async function exportWith(targetLanguage: string | undefined, translated: string, body: string) {
    const result = await exportDocx(await makeDocx(body), [cellAt(1, translated)], { targetLanguage })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const xml = await zip.file("word/document.xml")!.async("string")
    expectWellFormed(xml)
    expectNoNewStructuralProblems(documentXml(body), xml)
    return xml
  }
  const body = para(run("The word ", EN) + run("שנה", HEB) + run(" means: year!", EN))

  it("French: no-break spaces in translated text, French proofing on translated runs, unchanged text keeps its own", async () => {
    const xml = await exportWith("fr-FR", "Le mot שנה signifie : année !", body)
    expect(xml).toContain(`<w:r><w:rPr><w:sz w:val="22"/><w:lang w:val="fr-FR" w:eastAsia="zh-CN"/></w:rPr><w:t xml:space="preserve">Le mot </w:t></w:r>`)
    expect(xml).toContain(`<w:r>${HEB}<w:t xml:space="preserve">שנה</w:t></w:r>`)
    expect(xml).toContain(` signifie${NB}: année${NB}!</w:t>`)
  })

  it("another language: proofing language only, no French spacing", async () => {
    const xml = await exportWith("es", "La palabra שנה significa : año !", body)
    expect(xml).toContain('<w:lang w:val="es" w:eastAsia="zh-CN"/>')
    expect(xml).not.toContain(NB)
  })

  it("unknown language: neither", async () => {
    const xml = await exportWith(undefined, "Le mot שנה signifie : année !", body)
    expect(xml).not.toContain("fr-FR")
    expect(xml).not.toContain(NB)
    expect(xml).toContain('<w:lang w:val="en-US" w:eastAsia="zh-CN"/>')
  })

  it("adds a w:lang where the run had none, at its schema place", async () => {
    const xml = await exportWith("fr", "Bonjour", para(run("Hello", '<w:rPr><w:b/><w:sz w:val="20"/><w:rtl/></w:rPr>')))
    expect(xml).toContain('<w:rPr><w:b/><w:sz w:val="20"/><w:rtl/><w:lang w:val="fr"/></w:rPr>')
  })
})

describe("exportDocx — translated footnote text (AQU-2539)", () => {
  async function exportNotes(body: string, notes: string, translated: string, targetLanguage?: string) {
    const result = await exportDocx(await makeDocx(body, notes), [cellAt(1, translated)], { targetLanguage })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const doc = await zip.file("word/document.xml")!.async("string")
    const fn = await zip.file("word/footnotes.xml")!.async("string")
    expectWellFormed(doc)
    expectWellFormed(fn)
    expectNoNewStructuralProblems(documentXml(body), doc, notes, fn)
    return { doc, fn, result }
  }
  const body = para(run("Text") + footnoteRefRun(1) + run(" more."))

  it("writes the marker's translated note into its footnote, number and space kept", async () => {
    const { fn, result } = await exportNotes(body, footnotesXml({ 1: "A note: here." }), "Texte\\f + \\ft Une note : ici.\\f* encore.", "fr-FR")
    expect(fn).toContain('<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:rPr><w:lang w:val="fr-FR"/></w:rPr><w:t xml:space="preserve"> Une note : ici.</w:t></w:r></w:p></w:footnote>')
    expect(fn).not.toContain("A note")
    expect(result.fidelity.notesWritten).toBe(1)
  })

  it("leaves footnotes.xml byte-identical when the note's text did not change", async () => {
    const notes = footnotesXml({ 1: "A note." })
    const { fn } = await exportNotes(body, notes, "Texte\\f + \\ft A note.\\f* encore.")
    expect(fn).toBe(notes)
  })

  it("leaves a note of several paragraphs in its own words, and says so", async () => {
    const notes = footnotesXml({ 1: "First." }).replace("</w:p></w:footnote></w:footnotes>", `</w:p>${para(run("Second."))}</w:footnote></w:footnotes>`)
    const { fn, result } = await exportNotes(body, notes, "Texte\\f + \\ft Premier. Second.\\f* encore.")
    expect(fn).toBe(notes)
    expect(result.fidelity.notesLeft).toBe(1)
  })
})

describe("exportDocx — a paragraph cut into several lines (AQU-2539)", () => {
  it("joins the lines with the line break or tab the source had between them", async () => {
    const long = "word ".repeat(30).trim()
    const body = para(`<w:r><w:t xml:space="preserve">${long}. </w:t><w:br/><w:t xml:space="preserve">${long} end.</w:t></w:r>`)
    const strings = docxPartsToStrings({ documentXml: documentXml(body) })
    expect(strings.length).toBe(2)
    // The second line starts at the break; translations are always trimmed.
    expect(strings[1].original.startsWith("\n")).toBe(true)
    const { xml } = await exportedXml(body, importedCells(strings, (s) => `FR ${s.original.trim()}`))
    expect(xml).toMatch(/FR word[^<]*<\/w:t><w:br\/><w:t xml:space="preserve">FR word/)
  })
})

describe("exportDocx — review findings (AQU-2539)", () => {
  it("a field holding the first word, its result not found, closes before the translation", async () => {
    const body = para(complexField("PAGE", "12") + run(" pages in total."))
    const { xml } = await exportedXml(body, [cellAt(1, "Douze pages au total.")])
    const end = xml.indexOf('w:fldCharType="end"')
    expect(end).toBeGreaterThan(-1)
    expect(end).toBeLessThan(xml.indexOf("Douze pages au total."))
    expect(xml).not.toContain(">12<")
  })

  it("a content control whose text changed keeps its own tags, emptied", async () => {
    const sdt = `<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent>${run("Sam")}</w:sdtContent></w:sdt>`
    const { xml } = await exportedXml(para(run("Welcome, ") + sdt + run(".")), [cellAt(1, "Bienvenue, Samuel.")])
    expect(xml).toContain('<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent></w:sdtContent></w:sdt>')
    // Never an sdtPr loose in the paragraph.
    expect(xml).not.toMatch(/<\/w:r><w:sdtPr>/)
  })

  it("a wrapper with no text (a tracked insertion around a picture) is kept as it is", async () => {
    const ins = `<w:ins w:id="5" w:author="a" w:date="2026-01-01T00:00:00Z">${pictureRun}</w:ins>`
    const { xml } = await exportedXml(para(run("Before ") + ins + run("after.")), [cellAt(1, "Avant après.")])
    expect(xml).toContain(ins)
  })

  it("a kept link's own space is not written twice", async () => {
    const link = `<w:hyperlink r:id="rId3">${run("Google ")}</w:hyperlink>`
    const { xml } = await exportedXml(para(run("Use ") + link + run("now.")), [cellAt(1, "Utilisez Google maintenant.")])
    expect(xml).toContain(`Utilisez </w:t></w:r>${link}<w:r><w:t xml:space="preserve">maintenant.</w:t>`)
  })

  it("keeps a non-breaking hyphen in its word, both ways", async () => {
    const body = para(`<w:r><w:t>John 3:16</w:t><w:noBreakHyphen/><w:t>18 says</w:t></w:r>`)
    const strings = docxPartsToStrings({ documentXml: documentXml(body) })
    expect(strings[0].original).toBe("John 3:16‑18 says")
    const { xml } = await exportedXml(body, importedCells(strings, () => "Jean 3:16‑18 dit"))
    expect(xml).toContain('Jean 3:16</w:t><w:noBreakHyphen/><w:t xml:space="preserve">18 dit</w:t>')
  })

  it("a translator's bold does not borrow a Hebrew look", async () => {
    const HEB_BOLD = '<w:rPr><w:rFonts w:ascii="SBL Hebrew"/><w:b/><w:rtl/></w:rPr>'
    const body = para(run("The word ") + run("שלום", HEB_BOLD) + run(" means peace."))
    const html = "<p>Le mot <strong>shalom</strong> signifie paix.</p>"
    const { xml } = await exportedXml(body, [cellAt(1, "Le mot shalom signifie paix.", { translatedHtml: html })])
    expect(xml).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">shalom</w:t></w:r>')
    expect(xml).not.toContain("SBL Hebrew</w:t>")
  })

  it("a removed paragraph inside a text box is emptied, never dropped, so the box stays valid", async () => {
    const body = para(run("Holder ") + textBoxRun(para(run("Only line"), "Caption")))
    const removedCells = [{ metadata: { aquillaImport: { sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: "w:p[2]", segment: 1 } } } }]
    const result = await exportDocx(await makeDocx(body), [cellAt(1, "Porteur")], { removedCells })
    const xml = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file("word/document.xml")!.async("string")
    expectWellFormed(xml)
    expect(xml.match(/<w:txbxContent><w:p><w:pPr><w:pStyle w:val="Caption"\/><\/w:pPr><\/w:p><\/w:txbxContent>/g)).toHaveLength(2)
    expect(result.removed).toBe(1)
  })

  it("a fresh two-line paragraph that repeats its text box's words is written, even with one line translated", async () => {
    const long = "word ".repeat(30).trim()
    const repeat = para(run(`As Figure 5 shows, ${long}. And again ${long}.`) + textBoxRun(para(run("Figure 5"))))
    const strings = docxPartsToStrings({ documentXml: documentXml(repeat) })
    const cells = importedCells(strings, (s) => (s.original.startsWith("As") ? "Comme le montre la figure 5" : ""))
    const { xml, result } = await exportedXml(repeat, cells)
    expect(result.fidelity.staleTextBoxHolders).toBe(0)
    expect(xml).toContain("Comme le montre la figure 5")
  })

  it("leaves a note alone whose text only differs in spacing the marker collapsed", async () => {
    const body = para(run("Text") + footnoteRefRun(1) + run(" more."))
    const notes = footnotesXml({ 1: "See  John 3." })
    const strings = docxPartsToStrings({ documentXml: documentXml(body), footnotesXml: notes })
    const result = await exportDocx(await makeDocx(body, notes), importedCells(strings, (s) => s.original.replace("Text", "Texte")))
    const fn = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file("word/footnotes.xml")!.async("string")
    expect(fn).toBe(notes)
    expect(result.fidelity.notesWritten).toBe(0)
  })
})

describe("exportDocx — kept looks on a translation that differs from the source (AQU-2539)", () => {
  const I = "<w:rPr><w:i/></w:rPr>"
  const HL = '<w:rPr><w:highlight w:val="cyan"/></w:rPr>'
  const SUP = '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
  const A = '<w:rPr><w:sz w:val="22"/></w:rPr>'
  const B = '<w:rPr><w:sz w:val="24"/></w:rPr>'

  it("keeps an italic phrase the French kept, in a paragraph that mixes two plain looks", async () => {
    // Half the paragraph in one plain look, half in another: the italic words
    // are still found on their own.
    const body = para(run("The text of the Greek New Testament, ", A) + run("known as the ", B) + run("Textus Receptus", I) + run(" for centuries.", B))
    const { xml } = await exportedXml(body, [cellAt(1, "Le texte du Nouveau Testament grec, appelé Textus Receptus pendant des siècles.")])
    expect(xml).toContain(`<w:r>${I}<w:t xml:space="preserve">Textus Receptus</w:t></w:r>`)
  })

  it("opens a stretch the French did not keep into its words, without their edge punctuation", async () => {
    const body = para(run("Long ago the text was written without spaces between the words. For example, ") + run("when we read in English “godisnowhere”,", HL) + run(" is the meaning clear?"))
    const { xml } = await exportedXml(body, [cellAt(1, "Autrefois le texte était écrit sans espaces. Par exemple, lorsque nous lisons en anglais « godisnowhere », le sens est-il clair ?")])
    expect(xml).toContain(`<w:r>${HL}<w:t xml:space="preserve">godisnowhere</w:t></w:r>`)
    expect(xml).not.toContain(`${HL}<w:t xml:space="preserve">Par`)
  })

  it("keeps a word made of several looks as that word: the superscript of 4QSamᵃ", async () => {
    const body = para(run("The LXX, supported by 4QSam") + run("a", SUP) + run(", adds a word."))
    const { xml } = await exportedXml(body, [cellAt(1, "La LXX, soutenue par 4QSama, ajoute un mot.")])
    expect(xml).toContain(`4QSam</w:t></w:r><w:r>${SUP}<w:t xml:space="preserve">a</w:t></w:r>`)
    // The French "a" of "il a" is never given the superscript.
    const other = await exportedXml(para(run("Codex ") + run("a", SUP) + run(" reads it.")), [cellAt(1, "Le codex a la leçon.")])
    expect(other.xml).not.toContain("superscript")
  })
})

describe("exportDocx — tabs and breaks of an old import (AQU-2539)", () => {
  const listLine = para(`<w:r><w:t>KJV</w:t><w:tab/><w:t>King James Version</w:t></w:r>`)

  it("puts the tab back after the unchanged first word, where the old cell had glued them", async () => {
    // dev's importer dropped the tab: the old cell's source is "KJVKing James Version".
    const { xml } = await exportedXml(listLine, [cellAt(1, "KJVVersion King James", { original: "KJVKing James Version" })])
    expect(xml).toContain('KJV</w:t><w:tab/><w:t xml:space="preserve">Version King James</w:t>')
  })

  it("replaces the space the translation put there with the tab", async () => {
    const { xml } = await exportedXml(listLine, [cellAt(1, "KJV Version King James", { original: "KJVKing James Version" })])
    expect(xml).toContain('KJV</w:t><w:tab/><w:t xml:space="preserve">Version King James</w:t>')
  })

  it("puts a line break back before an unchanged last stretch", async () => {
    const body = para(`<w:r><w:t xml:space="preserve">Most manuscripts read: </w:t><w:br/><w:t>πας ο αρνουμενος</w:t></w:r>`)
    const { xml } = await exportedXml(body, [cellAt(1, "La plupart des manuscrits ont : πας ο αρνουμενος", { original: "Most manuscripts read: πας ο αρνουμενος" })])
    expect(xml).toContain('ont :</w:t><w:br/><w:t xml:space="preserve">πας ο αρνουμενος</w:t>')
  })

  it("never splits a word that only begins with the same letters, nor uses a lone letter", async () => {
    const glued = para(`<w:r><w:t>REB</w:t><w:tab/><w:t>Revised English Bible</w:t></w:r>`)
    const fresh = await exportedXml(glued, [cellAt(1, "REBELLE Bible", { original: "REB\tRevised English Bible" })])
    expect(fresh.xml).not.toContain("<w:tab/>")
    const letter = para(`<w:r><w:t>A</w:t><w:tab/><w:t>first item</w:t></w:r>`)
    const lone = await exportedXml(letter, [cellAt(1, "Avant-premier élément", { original: "Afirst item" })])
    expect(lone.xml).not.toContain("<w:tab/>")
  })

  it("leaves a translation that carries its own tabs alone", async () => {
    const { xml } = await exportedXml(listLine, [cellAt(1, "KJV\tVersion King James", { original: "KJV\tKing James Version" })])
    expect(xml.match(/<w:tab\/>/g)).toHaveLength(1)
  })
})

describe("exportDocx — a mostly right-to-left line (AQU-2539)", () => {
  it("writes the French in the line's left-to-right look, not the Hebrew look", async () => {
    const HEB = '<w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial"/><w:rtl/></w:rPr>'
    // Pointed Hebrew is long in UTF-16 units (each point is one); letters count.
    const hebrew = "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ"
    const body = para(run("for day (one ") + run(hebrew, HEB) + run(")"))
    const { xml } = await exportedXml(body, [cellAt(1, `pour jour (un ${hebrew})`)])
    expect(xml).toContain('<w:r><w:t xml:space="preserve">pour jour (un </w:t></w:r>')
    expect(xml).toContain(`<w:r>${HEB}<w:t xml:space="preserve">${hebrew}</w:t></w:r>`)
  })
})

describe("exportDocx — removing the last paragraph of a container (AQU-2539)", () => {
  const removedAt = (...ps: number[]) =>
    ps.map((p) => ({ metadata: { aquillaImport: { sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: `w:p[${p}]`, segment: 1 } } } }))
  const cellOf = (inner: string) => `<w:tbl><w:tr><w:tc><w:tcPr/>${inner}</w:tc></w:tr></w:tbl>`

  async function exportRemoving(body: string, removed: number[]) {
    const result = await exportDocx(await makeDocx(body), [], { removedCells: removedAt(...removed) })
    const xml = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file("word/document.xml")!.async("string")
    expectWellFormed(xml)
    expectNoNewStructuralProblems(documentXml(body), xml)
    return { xml, result }
  }

  it("empties the only paragraph of a table cell instead of leaving the cell without one", async () => {
    const { xml, result } = await exportRemoving(para(run("Before")) + cellOf(para(run("Only line"), "TableParagraph")) + para(run("After")), [2])
    expect(xml).toContain('<w:tc><w:tcPr/><w:p><w:pPr><w:pStyle w:val="TableParagraph"/></w:pPr></w:p></w:tc>')
    expect(result.removed).toBe(1)
  })

  it("drops a paragraph that is not its container's last, empties the one that is", async () => {
    const both = await exportRemoving(cellOf(para(run("One")) + para(run("Two"))) + para(run("After")), [1, 2])
    expect(both.xml).toContain("<w:tc><w:tcPr/><w:p></w:p></w:tc>")
    expect(both.xml).not.toContain("One")
    const first = await exportRemoving(cellOf(para(run("One")) + para(run("Two"))) + para(run("After")), [1])
    expect(first.xml).toContain(`<w:tc><w:tcPr/>${para(run("Two"))}</w:tc>`)
  })
})

describe("the structural check itself (AQU-2539)", () => {
  it("finds what Word would reject", () => {
    const bad = documentXml(
      `<w:tbl><w:tr><w:tc><w:tcPr/></w:tc></w:tr></w:tbl>` +
        para(`<w:bookmarkStart w:id="1" w:name="a"/>${run("x")}`) +
        para(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF missing </w:instrText></w:r>${footnoteRefRun(9)}`) +
        // AQU-2552 (question 62): an emptied link is schema-valid, so not flagged.
        para(`<w:hyperlink r:id="rId1"></w:hyperlink><w:r><w:rPr><w:i/><w:b/></w:rPr><w:t>y</w:t></w:r>`),
    )
    expect(structuralProblems(bad, footnotesXml({ 2: "A note." })).sort()).toEqual([
      "REF to a missing bookmark: missing",
      "bookmarkStart with no end: 1",
      "field begin without end (1)",
      "footnoteReference to a missing note: 9",
      "w:rPr children out of order: i,b",
      "w:tc not ending in w:p",
    ])
  })
})

describe("exportDocx — the well-formedness guard (AQU-2539)", () => {
  it("refuses to hand back a document.xml that does not parse", async () => {
    // A source broken outside any paragraph: the rebuilt part copies it, and
    // the guard stops the export instead of handing Word a corrupt file.
    const zip = new JSZip()
    zip.file("word/document.xml", documentXml(para(run("Hello"))) + "</w:extra>")
    const raw = await zip.generateAsync({ type: "arraybuffer" })
    await expect(exportDocx(raw, [cellAt(1, "Bonjour")])).rejects.toThrow(/Word export stopped: the rebuilt word\/document\.xml is not well-formed/)
  })
})

describe("exportDocx — footnotes the translation reorders (AQU-2539)", () => {
  it("gives each reference, in order, the note text of the marker at its place", async () => {
    const body = para(run("First") + footnoteRefRun(1) + run(" and second") + footnoteRefRun(2) + run("."))
    const notes = footnotesXml({ 1: "Note one.", 2: "Note two." })
    // The French puts the second note's marker first.
    const translated = "D'abord la seconde\\f + \\ft Note deux.\\f* puis la première\\f + \\ft Note un.\\f*."
    const result = await exportDocx(await makeDocx(body, notes), [cellAt(1, translated)])
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const xml = await zip.file("word/document.xml")!.async("string")
    const fn = await zip.file("word/footnotes.xml")!.async("string")
    expectNoNewStructuralProblems(documentXml(body), xml, notes, fn)
    // References stay in document order (Word numbers them 1, 2 by position);
    // each note gets the text written at its place in the translation.
    expect(xml.indexOf('w:footnoteReference w:id="1"')).toBeLessThan(xml.indexOf('w:footnoteReference w:id="2"'))
    expect(fn).toContain('<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note deux.</w:t></w:r></w:p></w:footnote>')
    expect(fn).toContain('<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note un.</w:t></w:r></w:p></w:footnote>')
  })
})

describe("exportDocx — unchanged text in another Unicode form (AQU-2539)", () => {
  it("finds a pointed Hebrew word the translation holds in another normal form, and writes the source's own bytes", async () => {
    const HEB = '<w:rPr><w:rFonts w:cs="SBL Hebrew"/><w:rtl/></w:rPr>'
    // Source: shin + dagesh + qamats (not canonical order); NFC puts qamats first.
    const source = "\u05e9\u05bc\u05b8\u05e0\u05b8\u05d4"
    const other = source.normalize("NFC")
    expect(other).not.toBe(source)
    const body = para(run("The long story of the word ") + run(source, HEB) + run(" means year in Hebrew."))
    const { xml } = await exportedXml(body, [cellAt(1, `La longue histoire du mot ${other} signifie année en hébreu.`)])
    expect(xml).toContain(`<w:r>${HEB}<w:t xml:space="preserve">${source}</w:t></w:r>`)
    expect(xml).not.toContain(other)
  })
})

describe("exportDocx — repeated words, joined stretches, short words, base look (AQU-2539)", () => {
  const I = "<w:rPr><w:i/></w:rPr>"
  const B = "<w:rPr><w:b/></w:rPr>"

  it("gives the look to the occurrence it belongs to when the word occurs as often in both", async () => {
    const body = para(run("But my people have changed ") + run("my", I) + run(" glory."))
    const { xml } = await exportedXml(body, [cellAt(1, "But my people have changed my glory.")])
    expect(xml).toContain(`<w:r><w:t xml:space="preserve">But my people have changed </w:t></w:r><w:r>${I}<w:t xml:space="preserve">my</w:t></w:r>`)
    const quoted = para(run("Before Abraham was, the text says; and later ") + run("Abraham", I) + run(" believed."))
    const fr = await exportedXml(quoted, [cellAt(1, "Avant Abraham, dit le texte ; et plus tard Abraham crut.")])
    expect(fr.xml).toContain(`plus tard </w:t></w:r><w:r>${I}<w:t xml:space="preserve">Abraham</w:t></w:r>`)
  })

  it("joins a stretch of one look across a space that has a look of its own", async () => {
    const body = para(run("Then he came ") + run("to", B) + run(" ", '<w:rPr><w:b/><w:spacing w:val="-1"/></w:rPr>') + run("him", B) + run(" and spoke to him."))
    const { xml } = await exportedXml(body, [cellAt(1, "Then he came to him and spoke to him.")])
    expect(xml).toContain(`came </w:t></w:r><w:r>${B}<w:t xml:space="preserve">to</w:t></w:r>`)
    expect(xml).toContain(`<w:t xml:space="preserve"> and spoke to him.</w:t>`)
  })

  it("never lets a short word taken out of a stretch take a look (italic de facto, French de)", async () => {
    const body = para(run("It became the ") + run("de facto", I) + run(" standard of the field."))
    const { xml } = await exportedXml(body, [cellAt(1, "Il est devenu la norme de fait du domaine.")])
    expect(xml).not.toContain("<w:i/>")
  })

  it("counts superscript like a mark for the base look (a cell of sigla)", async () => {
    const SZ = '<w:rPr><w:sz w:val="24"/></w:rPr>'
    const SUP = '<w:rPr><w:sz w:val="24"/><w:vertAlign w:val="superscript"/></w:rPr>'
    const body = para(run("p", SZ) + run("66,75", SUP) + run(" a", SZ) + run(" B ", SZ) + run("L ", SZ) + run("33,", SZ))
    const { xml } = await exportedXml(body, [cellAt(1, "p66,75 a B L 33,")])
    expect(xml).toContain(`<w:r>${SUP}<w:t xml:space="preserve">66,75</w:t></w:r>`)
    expect(xml).toContain(`<w:r>${SZ}<w:t xml:space="preserve"> a B L 33,</w:t></w:r>`)
  })

  it("counts letters, not characters, for the base look (accents are not letters)", async () => {
    const A = '<w:rPr><w:sz w:val="20"/></w:rPr>'
    const W2 = '<w:rPr><w:sz w:val="22"/></w:rPr>'
    // Four Greek letters carrying two combining marks each: 12 UTF-16 units.
    const greek = "ἄἔἤἴ"
    const body = para(run(greek, A) + run(" words", W2))
    const { xml } = await exportedXml(body, [cellAt(1, "mots")])
    expect(xml).toContain(`<w:r>${W2}<w:t xml:space="preserve">mots</w:t></w:r>`)
  })
})

describe("exportDocx — an old import's cell for the paragraph holding a text box (AQU-2539)", () => {
  // w:p[1] holds the box and a picture (no words of its own); w:p[2] is the
  // caption in the box (Choice), w:p[3] its old-reader copy (Fallback).
  const caption = "Figure 1: Screenshot of the tool"
  const french = "Figure 1 : Capture d’écran de l’outil"
  const body = para(textBoxRun(para(run(caption), "Caption")) + pictureRun, "Caption") + para(run("Next"))
  const captionsIn = (xml: string) => xml.match(/>Figure 1 : Capture d’écran de l’outil</g)?.length ?? 0

  // As dev's importer made it: the caption four times, cut into two segments.
  const holderCells = (translate = true) => [
    cellAt(1, translate ? `${french}${french}${french.slice(0, 11)}` : "", { original: `${caption}${caption}${caption.slice(0, 10)}` }, 1),
    cellAt(1, translate ? `${french.slice(11).trim()}${french}` : "", { original: `${caption.slice(10)}${caption}` }, 2),
  ]

  it("writes the holder's cell to the text-box caption when its words are the caption repeated", async () => {
    const cells = [
      ...holderCells(),
      cellAt(2, "", { original: caption }),
      cellAt(3, "", { original: caption }),
      cellAt(4, "Suivant", { original: "Next" }),
    ]
    const { xml, result } = await exportedXml(body, cells)
    expect(captionsIn(xml)).toBe(2) // the caption and its Fallback copy
    expect(result.fidelity.textBoxCellsAdopted).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it("gives the text box its stored copy's own translation ahead of the holder's", async () => {
    // The partner's project: the Fallback copy's own cell is translated.
    const cells = [...holderCells(), cellAt(2, "", { original: caption }), cellAt(3, "Figure 1 : Traduction de la copie", { original: caption })]
    const { xml, result } = await exportedXml(body, cells)
    expect(xml.match(/>Figure 1 : Traduction de la copie</g)).toHaveLength(2) // the box and its copy
    expect(captionsIn(xml)).toBe(0)
    expect(result.fidelity.textBoxCellsAdopted).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it("says nothing about a holder whose cell has no translation", async () => {
    const cells = [...holderCells(false), cellAt(2, "", { original: caption }), cellAt(3, "", { original: caption })]
    const { xml, result } = await exportedXml(body, cells)
    expect(xml).toBe(documentXml(body))
    expect(result.warnings).toEqual([])
    expect(result.fidelity.textBoxCellsNotSplit).toBe(0)
  })

  it("says nothing about a holder left unvalidated in a validated-only export", async () => {
    // A drafted cell can carry its marks (translatedHtml) as well as its text.
    const drafted = holderCells().map((c) => ({ ...c, translatedHtml: `<p>${c.translated}</p>` }))
    const cells = scopeRoundTripCells([...drafted, cellAt(2, "", { original: caption })], "validated-only")
    const { xml, result } = await exportedXml(body, cells)
    expect(captionsIn(xml)).toBe(0)
    expect(result.warnings).toEqual([])
    expect(result.fidelity.textBoxCellsAdopted).toBe(0)
  })

  it("takes nothing from a translation of the right length that is not a clean repetition, and says so", async () => {
    // Exactly as long as the caption's French twice over, so only comparing
    // the repeats can tell: the second "repeat" ends in another word.
    const twice = `${french}${french.replace("l’outil", "l’objet")}`
    const letters = (t: string) => t.replace(/\s/g, "").length
    expect(letters(twice)).toBe(2 * letters(french))
    const cells = [cellAt(1, twice, { original: `${caption}${caption}` })]
    const { xml, result } = await exportedXml(body, cells)
    expect(captionsIn(xml)).toBe(0)
    expect(result.warnings.map((w) => w.segment)).toEqual([caption])
  })

  it("takes nothing from a cell that holds the caption's words among others, even when its translation repeats", async () => {
    // "Figure 1" and "Tables 2" have the same letter count: the source is twice
    // that long and contains the caption, but is not the caption repeated.
    const short = para(textBoxRun(para(run("Figure 1"), "Caption")) + pictureRun, "Caption")
    const cells = [cellAt(1, "Fig. 1Fig. 1", { original: "Figure 1Tables 2" })]
    const { xml, result } = await exportedXml(short, cells)
    expect(xml).not.toContain("Fig. 1")
    expect(result.warnings.map((w) => w.segment)).toEqual(["Figure 1"])
  })

  it("gives two text boxes with the same words nothing from one old cell, and names them", async () => {
    // w:p[1] holder; w:p[2], w:p[4] the two boxes; w:p[3], w:p[5] their copies.
    const two = para(textBoxRun(para(run(caption), "Caption")) + textBoxRun(para(run(caption), "Caption")), "Caption")
    const cells = [cellAt(1, `${french}${french}${french}${french}`, { original: `${caption}${caption}${caption}${caption}` })]
    const { xml, result } = await exportedXml(two, cells)
    expect(captionsIn(xml)).toBe(0)
    expect(result.warnings).toEqual([{ segment: caption, detail: expect.stringContaining("2 text boxes") }])
    expect(result.fidelity.textBoxCellsNotSplit).toBe(2)
  })

  it("gives the old cell to the one text box with those words still without a translation", async () => {
    const two = para(textBoxRun(para(run(caption), "Caption")) + textBoxRun(para(run(caption), "Caption")), "Caption")
    const cells = [
      cellAt(1, `${french}${french}${french}${french}`, { original: `${caption}${caption}${caption}${caption}` }),
      cellAt(2, "Figure 1 : La sienne", { original: caption }),
    ]
    const { xml, result } = await exportedXml(two, cells)
    expect(xml.match(/>Figure 1 : La sienne</g)).toHaveLength(2)
    expect(captionsIn(xml)).toBe(2) // the second box and its copy
    expect(result.warnings).toEqual([])
  })

  it("never gives a holder's cell to its box when the holder has words of its own; names both", async () => {
    // The cell's source is the caption twice over, but the paragraph has words
    // of its own: the cell is the holder's, stale, and the box is named too.
    const own = "See the screenshot below of the tool as it looks in this version"
    const withOwn = para(run(own) + textBoxRun(para(run(caption), "Caption")), "Caption")
    const cells = [cellAt(1, `${french}${french}`, { original: `${caption}${caption}` })]
    const { xml, result } = await exportedXml(withOwn, cells)
    expect(captionsIn(xml)).toBe(0)
    expect(result.warnings.map((w) => w.segment)).toEqual(["See the screenshot below of the tool as…", caption])
    expect(result.fidelity.staleTextBoxHolders).toBe(1)
  })

  it("keeps the warnings that ask for a re-import apart from words that lost their look", async () => {
    const mixed = para(run("Plain ") + run("bold", "<w:rPr><w:b/></w:rPr>") + run(" words"))
    const cells = [cellAt(1, "Clair gras mots", { original: "Plain bold words" }), cellAt(2, `${french} autre`, { original: `${caption}${caption}` })]
    const { result } = await exportedXml(mixed + body, cells)
    expect(result.warnings.map((w) => [w.segment, w.detail.includes("re-import")])).toEqual([[caption, true]])
    expect(result.lostLooks).toEqual([{ segment: "Plain bold words", words: ["bold"] }])
  })

  it("gives the text box its copy's translation on an import from before locators too", async () => {
    // No locators: the k-th group fills the k-th paragraph with any text
    // (holder, box, copy, next), as that importer made them.
    const positional = ["", "", "Figure 1 : Traduction de la copie", "Suivant"].map((translated, k) =>
      ({ ...cellAt(k + 1, translated, { original: k === 3 ? "Next" : caption }), metadata: {} }) as CellData)
    const { xml, result } = await exportedXml(body, positional)
    expect(xml.match(/>Figure 1 : Traduction de la copie</g)).toHaveLength(2)
    expect(xml).toContain(">Suivant<")
    expect(result.fidelity.textBoxCellsAdopted).toBe(1)
  })

  it("names a text-box caption with hidden words that the old cell held", async () => {
    // Dev's importer read the hidden word too, so the cell's source is not the
    // caption's line repeated: nothing is taken, and the caption is named.
    const partlyHidden = para(textBoxRun(para(run("Figure 4: ") + run("SECRET ", "<w:rPr><w:vanish/></w:rPr>") + run("Map"), "Caption")), "Caption")
    const cells = [cellAt(1, "Figure 4 : SECRET CarteFigure 4 : SECRET Carte", { original: "Figure 4: SECRET MapFigure 4: SECRET Map" })]
    const { xml, result } = await exportedXml(partlyHidden, cells)
    expect(xml).not.toContain("Carte")
    expect(result.warnings.map((w) => w.segment)).toEqual(["Figure 4: Map"])
  })

  it("keeps a holder with words of its own as it was when its box has hidden words the old cell held; names both (core check)", async () => {
    // The old cell read the hidden word, so the box's visible words are not
    // in it. It still held more than the holder's own words: it is stale, the
    // holder keeps its own words, and the caption is named, not written into
    // the holder's body.
    const own = "See the map below. "
    const withOwn = para(run(own) + textBoxRun(para(run("Figure 4: ") + run("SECRET ", "<w:rPr><w:vanish/></w:rPr>") + run("Map"), "Caption")))
    const cells = [cellAt(1, "Voir la carte ci-dessous. Figure 4 : SECRET CarteFigure 4 : SECRET Carte", { original: `${own}Figure 4: SECRET MapFigure 4: SECRET Map` })]
    const { xml, result } = await exportedXml(withOwn, cells)
    expect(xml).not.toContain("Carte")
    expect(result.fidelity.staleTextBoxHolders).toBe(1)
    expect(result.warnings.map((w) => w.segment)).toEqual(["See the map below.", "Figure 4: Map"])
  })

  it("keeps a holder with words of its own as it was when its box is all hidden in Word and the old cell held the box's words (review r9)", async () => {
    // The box has no visible words, so today's import makes no line of it,
    // but dev's importer read its hidden words into the holder's cell. The
    // cell is stale all the same: the holder keeps its own words. The box has
    // nothing to translate, so it is not named.
    const own = "See the map below. "
    const withOwn = para(run(own) + textBoxRun(para(run("SECRET", "<w:rPr><w:vanish/></w:rPr>"), "Caption")))
    const cells = [cellAt(1, "Voir la carte ci-dessous. SECRET", { original: `${own}SECRET` })]
    const { xml, result } = await exportedXml(withOwn, cells)
    expect(xml).not.toContain("Voir")
    expect(result.fidelity.staleTextBoxHolders).toBe(1)
    expect(result.warnings.map((w) => w.segment)).toEqual(["See the map below."])
  })

  it("names a text-box paragraph once, however many old cells held its words", async () => {
    // w:p[1] holder; w:p[2] the outer box ("Outer", holding the inner box
    // w:p[3], copy w:p[4]); w:p[5]..[7] the outer box's copy.
    const nested = para(textBoxRun(para(run("Outer ") + textBoxRun(para(run("Inner caption"))))))
    const cells = [
      cellAt(1, "Extérieur Légende intérieure", { original: "Outer Inner captionInner captionOuter Inner captionInner caption" }),
      cellAt(2, "Extérieur Légende", { original: "Outer Inner captionInner caption" }),
    ]
    const { result } = await exportedXml(nested, cells)
    expect(result.warnings.map((w) => w.segment)).toEqual(["Inner caption", "Outer"])

    // The outer box holding nothing but the inner one: both old cells held
    // the inner caption's words.
    const bare = para(textBoxRun(para(textBoxRun(para(run("Inner caption"))))))
    const bareCells = [
      cellAt(1, "Légende intérieure et plus", { original: "Inner captionInner captionInner captionInner caption" }),
      cellAt(2, "Légende intérieure, encore", { original: "Inner captionInner caption" }),
    ]
    const { result: bareResult } = await exportedXml(bare, bareCells)
    expect(bareResult.warnings.map((w) => w.segment)).toEqual(["Inner caption"])
  })

  it("leaves the holder's cell alone when the caption has a translation of its own", async () => {
    const cells = [cellAt(1, `${french}${french}`, { original: `${caption}${caption}` }), cellAt(2, "Figure 1 : Sa propre traduction", { original: caption })]
    const { xml, result } = await exportedXml(body, cells)
    expect(xml.match(/Sa propre traduction/g)).toHaveLength(2)
    expect(result.fidelity.textBoxCellsAdopted).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it("takes nothing from a translation that is not a clean repetition, and says so", async () => {
    const cells = [cellAt(1, `${french} et encore autre chose`, { original: `${caption}${caption}` })]
    const { xml, result } = await exportedXml(body, cells)
    expect(captionsIn(xml)).toBe(0)
    expect(result.warnings[0]).toEqual({
      segment: "Figure 1: Screenshot of the tool",
      detail: expect.stringContaining("re-import the file to translate it"),
    })
  })

  it("names every text-box paragraph an old cell held together with others", async () => {
    const two = para(textBoxRun(para(run("Bucket (English)")) + para(run("seau (French)"))), "Caption")
    const cells = [cellAt(1, "Seau (anglais)seau (français)", { original: "Bucket (English)seau (French)Bucket (English)seau (French)" })]
    const { result } = await exportedXml(two, cells)
    expect(result.warnings.map((w) => w.segment)).toEqual(["Bucket (English)", "seau (French)"])
    expect(result.fidelity.textBoxCellsNotSplit).toBe(2)
  })
})

describe("exportDocx — a fresh import's caption in a text box (AQU-2539)", () => {
  it("writes the caption's translation into the box and its copy, field kept in both", async () => {
    const seq = complexField("SEQ Figure \\\\* ARABIC", "1")
    const body = para(textBoxRun(para(run("Figure ") + seq + run(": Screenshot of the tool"), "Caption")) + pictureRun, "Caption")
    const strings = docxPartsToStrings({ documentXml: documentXml(body) })
    expect(strings.map((s) => [s.sourceLocation?.blockPath, s.context])).toEqual([["w:p[2]", "Caption"]])
    const { xml } = await exportedXml(body, importedCells(strings, () => "Figure 1 : Capture d’écran de l’outil"))
    const box = `<w:t xml:space="preserve">Figure </w:t></w:r>${seq}<w:r><w:t xml:space="preserve"> : Capture d’écran de l’outil</w:t></w:r>`
    expect(xml.split(box)).toHaveLength(3) // in the Choice and in the Fallback
  })
})

describe("exportDocx — which paragraphs lost a look (AQU-2539)", () => {
  const italic = "<w:rPr><w:i/></w:rPr>"

  it("lists no paragraph when every word with its own look is in the translation", async () => {
    const body = para(run("The text of the ") + run("Textus Receptus", italic) + run(" is late."))
    const { result } = await exportedXml(body, [cellAt(1, "Le texte du Textus Receptus est tardif.", { original: "The text of the Textus Receptus is late." })])
    expect(result.lostLooks).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("lists no paragraph whose words differ only in what a reader does not see", async () => {
    // Character spacing, proofing language and the complex-script size: no look.
    const quiet = '<w:rPr><w:spacing w:val="-2"/><w:lang w:val="en-GB"/><w:szCs w:val="20"/></w:rPr>'
    const body = para(run("Some ") + run("words here", quiet) + run(" and more"))
    const { result } = await exportedXml(body, [cellAt(1, "Quelques mots ici et plus", { original: "Some words here and more" })])
    expect(result.lostLooks).toEqual([])
  })

  it("names a paragraph whose ordinal lost its superscript", async () => {
    // "12th" is looked for as its whole word, which starts in the main look.
    const body = para(run("In the 12") + run("th", '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>') + run(" century."))
    const { result } = await exportedXml(body, [cellAt(1, "Au XIIe siècle.", { original: "In the 12th century." })])
    expect(result.lostLooks).toEqual([{ segment: "In the 12th century.", words: ["12th"] }])
  })

  it("names a paragraph whose ordinal lost its superscript when the digits carry a look the reader cannot see (core check)", async () => {
    // "12" carries a proofing language only: the stretch's look is the first
    // one a reader sees differently from the main look, the superscript.
    const lang = '<w:rPr><w:lang w:val="en-GB"/></w:rPr>'
    const body = para(run("In the ") + run("12", lang) + run("th", '<w:rPr><w:lang w:val="en-GB"/><w:vertAlign w:val="superscript"/></w:rPr>') + run(" century."))
    const { result } = await exportedXml(body, [cellAt(1, "Au XIIe siècle.", { original: "In the 12th century." })])
    expect(result.lostLooks).toEqual([{ segment: "In the 12th century.", words: ["12th"] }])
  })

  it("names the one paragraph whose words with their own look the translation changed, by its first words", async () => {
    const body =
      para(run("Kept ") + run("Codex Bezae", italic) + run(" here.")) +
      para(run("For the scribes of that time, the ") + run("more difficult", italic) + run(" reading was the one to fix first."))
    const cells = [
      cellAt(1, "Gardé Codex Bezae ici.", { original: "Kept Codex Bezae here." }),
      cellAt(2, "Pour les scribes de ce temps, la leçon plus difficile était celle à corriger d’abord.", { original: "For the scribes of that time, the more difficult reading was the one to fix first." }),
    ]
    const { result } = await exportedXml(body, cells)
    expect(result.lostLooks).toEqual([{ segment: "For the scribes of that time, the more…", words: ["more difficult"] }])
  })
})

describe("exportDocx — a paragraph cut into lines, some of them untranslated (AQU-2539)", () => {
  // A paragraph is exported as its lines in order: each line's translation,
  // or its source where it has none. Nothing is dropped because a neighbour
  // was translated.
  const lines = ["First line here.", "Second line here.", "Third line here."]
  const french = ["Première ligne ici.", "Deuxième ligne ici.", "Troisième ligne ici."]
  const body = para(run(lines.join(" ")))
  const cellsWith = (translated: boolean[], line = lines) =>
    line.map((original, k) => cellAt(1, translated[k] ? french[k] : "", { original }, k + 1))
  /** The visible text of the first paragraph of an export. */
  const firstParagraph = (xml: string) => docxPartsToStrings({ documentXml: xml }).filter((s) => s.sourceLocation?.blockPath === "w:p[1]").map((s) => s.original).join(" ")

  it.each([
    ["the middle line", [true, false, true], "Première ligne ici. Second line here. Troisième ligne ici."],
    ["the first line", [false, true, true], "First line here. Deuxième ligne ici. Troisième ligne ici."],
    ["the last line", [true, true, false], "Première ligne ici. Deuxième ligne ici. Third line here."],
    ["all lines but one", [false, true, false], "First line here. Deuxième ligne ici. Third line here."],
  ])("keeps %s's own words when it has no translation", async (_name, translated, want) => {
    const { xml } = await exportedXml(body, cellsWith(translated))
    expect(firstParagraph(xml)).toBe(want)
  })

  it("keeps the footnote of an untranslated line, its note left as it is", async () => {
    const withNote = para(run("First line here. Second line") + footnoteRefRun(1) + run(" here. Third line here."))
    const notes = footnotesXml({ 1: "A note." })
    const [line] = docxPartsToStrings({ documentXml: documentXml(withNote), footnotesXml: notes }, { cellUnit: "paragraph" })
    const parts = line.original.split(/(?<=here\.) /)
    expect(parts).toHaveLength(3)
    const cells = parts.map((original, k) => cellAt(1, k === 1 ? "" : french[k], { original }, k + 1))
    const result = await exportDocx(await makeDocx(withNote, notes), cells)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const xml = await zip.file("word/document.xml")!.async("string")
    expect(xml.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1)
    expect(firstParagraph(xml).replace(/\\f[\s\S]*?\\f\*/g, "")).toBe("Première ligne ici. Second line here. Troisième ligne ici.")
    expect(await zip.file("word/footnotes.xml")!.async("string")).toBe(notes)
  })

  it("keeps the field of an untranslated line", async () => {
    const withField = para(run("First line here. Second line on page ") + complexField("PAGE", "7") + run(". Third line here."))
    const original = ["First line here.", "Second line on page 7.", "Third line here."]
    const { xml } = await exportedXml(withField, cellsWith([true, false, true], original))
    expect(xml).toContain('<w:fldChar w:fldCharType="begin"/>')
    expect(xml).toContain("PAGE")
    expect(firstParagraph(xml)).toBe("Première ligne ici. Second line on page 7. Troisième ligne ici.")
  })

  it("writes an untranslated line in its own looks and characters: no French spacing, no French language", async () => {
    const italic = "<w:rPr><w:i/></w:rPr>"
    const mixed = para(run("First line here. Note 3 : 4, the ") + run("second", italic) + run(` line${"<"}/w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">here. Third line here.`))
    const original = ["First line here.", "Note 3 : 4, the second line\there.", "Third line here."]
    const cells = original.map((o, k) => cellAt(1, k === 1 ? "" : `${french[k].replace(".", "")} : fin.`, { original: o }, k + 1))
    const result = await exportDocx(await makeDocx(mixed), cells, { targetLanguage: "fr" })
    const xml = await (await JSZip.loadAsync(await result.blob.arrayBuffer())).file("word/document.xml")!.async("string")
    expectWellFormed(xml)
    // The source line: plain runs without w:lang, its italic word in its own run, its tab kept.
    expect(xml).toContain(`<w:r><w:t xml:space="preserve">Note 3 : 4, the </w:t></w:r>`)
    expect(xml).toContain(`<w:r>${italic}<w:t xml:space="preserve">second</w:t></w:r>`)
    expect(xml).toContain(`<w:r><w:t xml:space="preserve"> line</w:t><w:tab/><w:t xml:space="preserve">here.</w:t></w:r>`)
    // The translated lines: French language, and a no-break space before the colon.
    expect(xml).toContain(`<w:r><w:rPr><w:lang w:val="fr"/></w:rPr><w:t xml:space="preserve">Première ligne ici : fin. </w:t></w:r>`)
    expect(xml).not.toContain("3 :")
  })

  it("writes an unvalidated line's source, never its draft, in a validated-only export", async () => {
    const cells = cellsWith([true, true, true]).map((cell, k) => ({ ...cell, status: k === 1 ? "unvalidated" : "validated" }) as CellData)
    const { xml } = await exportedXml(body, scopeRoundTripCells(cells, "validated-only"))
    expect(firstParagraph(xml)).toBe("Première ligne ici. Second line here. Troisième ligne ici.")
    expect(xml).not.toContain("Deuxième")
  })
})
