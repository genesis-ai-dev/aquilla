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
    const xmlStr = await zip.file(slideFiles[slideIndex])!.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")
    const paragraphs = doc.getElementsByTagName("a:p")

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i]
      const { plain, html, hasFormatting } = extractPptxRuns(p)
      if (!plain.trim()) continue

      const context = `Slide ${slideIndex + 1}`
      const segments = splitIntoSegments(plain)

      for (const seg of segments) {
        results.push({
          id: uuid(),
          original: seg.text,
          originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
          translated: seg.text,
          context,
          group: seg.group,
          type: "text",
        })
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
