import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"

export async function extractPptxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  const zip = await JSZip.loadAsync(buffer)
  const results: TranslatableString[] = []

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0")
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0")
      return numA - numB
    })

  for (let slideIndex = 0; slideIndex < slideFiles.length; slideIndex++) {
    const slideFile = slideFiles[slideIndex]
    const xmlStr = await zip.file(slideFile)!.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")

    const shapes = doc.getElementsByTagName("p:sp")

    for (let spIdx = 0; spIdx < shapes.length; spIdx++) {
      const shape = shapes[spIdx]
      const paragraphs = shape.getElementsByTagName("a:p")
      const placeholder = shape.getElementsByTagName("p:ph")[0]
      const placeholderType = placeholder?.getAttribute("type")?.toLowerCase()
      const isTitleShape = placeholderType === "title" || placeholderType === "ctrtitle"

      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const p = paragraphs[pIdx]
        const { plain, html, hasFormatting } = extractPptxRuns(p)
        if (!plain.trim()) continue

        const context = `Slide ${slideIndex + 1}`
        const segments = splitIntoSegments(plain)
        const sourceLocation = {
          file: slideFile,
          blockPath: `p:sp[${spIdx + 1}]/p:txBody/a:p[${pIdx + 1}]`,
        }

        for (const seg of segments) {
          results.push({
            id: uuid(),
            original: seg.text,
            originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
            translated: "",
            context,
            group: seg.group,
            type: isTitleShape ? "heading" : "text",
            sourceLocation,
          })
        }
      }
    }
  }

  return results
}

function extractPptxRuns(p: Element): { plain: string; html: string; hasFormatting: boolean } {
  const runs = p.getElementsByTagName("a:r")
  let plain = ""
  let html = ""
  let hasFormatting = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const textEls = run.getElementsByTagName("a:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) {
      text += textEls[j].textContent || ""
    }
    if (!text) continue

    const rPr = run.getElementsByTagName("a:rPr")[0]
    const bold = rPr?.getAttribute("b") === "1"
    const italic = rPr?.getAttribute("i") === "1"
    const underline = rPr?.getAttribute("u") === "sng"
    const strike = rPr?.getAttribute("strike") === "sngStrike"

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
