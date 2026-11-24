import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import { buildPreviewDocument, documentPreviewKind, previewSignature } from "./build"

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

/** A one-slide deck with two one-paragraph shapes. */
async function deck(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const para = (text: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${para("Title words")}${para("Body words")}</p:spTree></p:cSld></p:sld>`,
  )
  return zip.generateAsync({ type: "arraybuffer" })
}

function cell(id: string, original: string, translated: string, extra: Partial<CellData> = {}): CellData {
  return { id, original, translated, group: id, type: "paragraph", ...extra } as CellData
}

async function wordsOf(bytes: ArrayBuffer): Promise<string[]> {
  return (await extractPptxStrings(bytes)).map((s) => s.original)
}

describe("documentPreviewKind", () => {
  // Only files whose original is a document a library can draw get the panel.
  it("offers a preview for Word, PowerPoint and InDesign files and nothing else", () => {
    expect(documentPreviewKind("docx")).toBe("docx")
    expect(documentPreviewKind("pptx")).toBe("pptx")
    expect(documentPreviewKind("idml")).toBe("idml")
    for (const type of ["usfm", "md", "xlsx", undefined, null]) expect(documentPreviewKind(type)).toBeNull()
  })
})

describe("buildPreviewDocument", () => {
  // The preview is the export: a translated line shows its translation, and a
  // line with none still shows the client's own words.
  it("puts translations into the original and leaves untranslated lines alone", async () => {
    const bytes = await buildPreviewDocument("pptx", await deck(), [
      cell("a", "Title words", "Mots du titre"),
      cell("b", "Body words", ""),
    ])
    expect(await wordsOf(bytes)).toEqual(["Mots du titre", "Body words"])
  })

  // AQU-1423: a hidden line is not in the download, so it must not be in the
  // preview either, whatever translation it still holds.
  it("shows no translation for a hidden line", async () => {
    const bytes = await buildPreviewDocument("pptx", await deck(), [
      cell("a", "Title words", "Mots du titre", { hidden: true }),
      cell("b", "Body words", "Mots du corps"),
    ])
    const words = await wordsOf(bytes)
    expect(words).not.toContain("Mots du titre")
    expect(words).toContain("Mots du corps")
  })
})

describe("previewSignature", () => {
  const base = [cell("a", "One", "Un"), cell("b", "Two", "")]

  // A rebuild costs a whole export, so only what changes the document may ask for one.
  it("changes when a translation or a line's hidden state changes", () => {
    const signature = previewSignature(base)
    expect(previewSignature([base[0], cell("b", "Two", "Deux")])).not.toBe(signature)
    expect(previewSignature([{ ...base[0], hidden: true }, base[1]])).not.toBe(signature)
    expect(previewSignature([{ ...base[0], translatedHtml: "<p><strong>Un</strong></p>" }, base[1]])).not.toBe(signature)
  })

  it("stays the same when a cell changes in a way the document does not show", () => {
    const touched = base.map((c) => ({ ...c, validatedBy: ["someone"], commentCount: 3 }) as CellData)
    expect(previewSignature(touched)).toBe(previewSignature(base))
  })
})
