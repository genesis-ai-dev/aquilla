import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"
import { assertSafeArchiveInputSize, assertSafeZipArchive } from "./zip-safety"

export async function extractDocxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  assertSafeArchiveInputSize(buffer.byteLength, "DOCX file")
  const zip = await JSZip.loadAsync(buffer)
  assertSafeZipArchive(zip, "DOCX file")
  const documentEntry = zip.file("word/document.xml")
  if (!documentEntry) throw new Error("DOCX file does not contain word/document.xml")
  const xmlStr = await documentEntry.async("string")
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml")
  const results: TranslatableString[] = []
  const paragraphs = doc.getElementsByTagName("w:p")

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const { plain, html, hasFormatting } = extractRuns(p)
    if (!plain.trim()) continue

    const style = getParaStyle(p)
    const context = style || "Paragraph"
    const type = style?.startsWith("Heading") || style === "Title"
      ? ("heading" as const)
      : ("text" as const)
    const segments = splitIntoSegments(plain)
    const sourceLocation = {
      file: "word/document.xml",
      blockPath: `w:p[${i + 1}]`,
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      results.push({
        id: uuid(),
        original: seg.text,
        originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
        translated: "",
        context,
        group: seg.group,
        type,
        sourceLocation,
        // D2: first sub-cell of each paragraph block carries paragraphStart; continuations do not.
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    }
  }

  return results
}

function extractRuns(p: Element): { plain: string; html: string; hasFormatting: boolean } {
  const runs = p.getElementsByTagName("w:r")
  let plain = ""
  let html = ""
  let hasFormatting = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const textEls = run.getElementsByTagName("w:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) {
      text += textEls[j].textContent || ""
    }

    if (!text) continue

    const rPr = run.getElementsByTagName("w:rPr")[0]
    const bold = rPr?.getElementsByTagName("w:b").length > 0
    const italic = rPr?.getElementsByTagName("w:i").length > 0
    const underline = rPr?.getElementsByTagName("w:u").length > 0
    const strike = rPr?.getElementsByTagName("w:strike").length > 0

    plain += text

    let htmlText = text
    if (bold) { htmlText = `<b>${htmlText}</b>`; hasFormatting = true }
    if (italic) { htmlText = `<i>${htmlText}</i>`; hasFormatting = true }
    if (underline) { htmlText = `<u>${htmlText}</u>`; hasFormatting = true }
    if (strike) { htmlText = `<s>${htmlText}</s>`; hasFormatting = true }
    html += htmlText
  }

  return { plain, html, hasFormatting }
}

function getParaStyle(p: Element): string | null {
  const pPr = p.getElementsByTagName("w:pPr")[0]
  if (!pPr) return null
  const pStyle = pPr.getElementsByTagName("w:pStyle")[0]
  if (!pStyle) return null
  const val = pStyle.getAttribute("w:val") || ""

  const headingMatch = val.match(/^Heading(\d+)$/i)
  if (headingMatch) return `Heading ${headingMatch[1]}`
  if (val === "Title") return "Title"
  return val
}
