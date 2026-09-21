import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"
import { assertSafeArchiveInputSize, assertSafeZipArchive } from "./zip-safety"

/** ppt/slides/slideN.xml, numerically ordered — the deck order both the
 *  importer and the exporter (src/lib/export/exporters/pptx.ts) walk. */
export function pptxSlideParts(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0")
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0")
      return numA - numB
    })
}

export interface PptxParagraphBlock {
  /** The `a:p` element this block covers. */
  p: Element
  /** Where the paragraph lives inside the slide part — the locator the
   *  exporter matches on, so it must stay stable across releases. */
  blockPath: string
  /** Text boxes vs. table cells. The exporter's legacy positional fallback
   *  only walks `shape` blocks, because decks imported before table support
   *  have no cells for the table paragraphs to line up against. */
  kind: "shape" | "table"
  /** Title/centred-title placeholder — imported as a structural heading. */
  isTitle: boolean
}

/**
 * Every text-bearing paragraph of one slide, in document order.
 *
 * Shared by the importer and the PPTX exporter so the two walks can never
 * drift — the exporter matches translations back by `blockPath`, and its
 * legacy path matches by position in this list.
 *
 * `p:sp` numbering is the shape's index among the slide's `p:sp` elements in
 * document order, and tables are numbered independently among `p:graphicFrame`
 * elements. Adding table support therefore leaves every previously emitted
 * `p:sp[...]` locator pointing at exactly the same paragraph.
 */
export function pptxParagraphBlocks(doc: Document): PptxParagraphBlock[] {
  const blocks: PptxParagraphBlock[] = []
  const all = doc.getElementsByTagName("*")
  let shapeIndex = 0
  let frameIndex = 0

  for (let i = 0; i < all.length; i++) {
    const el = all[i]

    if (el.tagName === "p:sp") {
      const n = ++shapeIndex
      const placeholderType = el.getElementsByTagName("p:ph")[0]?.getAttribute("type")?.toLowerCase()
      const isTitle = placeholderType === "title" || placeholderType === "ctrtitle"
      const paragraphs = el.getElementsByTagName("a:p")
      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        blocks.push({
          p: paragraphs[pIdx],
          blockPath: `p:sp[${n}]/p:txBody/a:p[${pIdx + 1}]`,
          kind: "shape",
          isTitle,
        })
      }
      continue
    }

    if (el.tagName === "p:graphicFrame") {
      // A graphic frame can hold a chart or a SmartArt diagram instead; only a
      // table carries translatable paragraphs we can round-trip. The frame
      // still consumes an index either way, so the numbering stays positional.
      const n = ++frameIndex
      const tbl = el.getElementsByTagName("a:tbl")[0]
      if (!tbl) continue
      const rows = directChildren(tbl, "a:tr")
      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const cells = directChildren(rows[rIdx], "a:tc")
        for (let cIdx = 0; cIdx < cells.length; cIdx++) {
          const paragraphs = cells[cIdx].getElementsByTagName("a:p")
          for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
            blocks.push({
              p: paragraphs[pIdx],
              blockPath: `p:graphicFrame[${n}]/a:tbl/a:tr[${rIdx + 1}]/a:tc[${cIdx + 1}]/a:txBody/a:p[${pIdx + 1}]`,
              kind: "table",
              isTitle: false,
            })
          }
        }
      }
    }
  }

  return blocks
}

function directChildren(parent: Element, tagName: string): Element[] {
  const out: Element[] = []
  const children = parent.children
  for (let i = 0; i < children.length; i++) {
    if (children[i].tagName === tagName) out.push(children[i])
  }
  return out
}

export async function extractPptxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  assertSafeArchiveInputSize(buffer.byteLength, "PPTX file")
  const zip = await JSZip.loadAsync(buffer)
  assertSafeZipArchive(zip, "PPTX file")
  const results: TranslatableString[] = []

  const slideFiles = pptxSlideParts(zip)
  if (slideFiles.length === 0) throw new Error("PPTX file does not contain any readable slides")

  for (let slideIndex = 0; slideIndex < slideFiles.length; slideIndex++) {
    const slideFile = slideFiles[slideIndex]
    const xmlStr = await zip.file(slideFile)!.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")

    for (const block of pptxParagraphBlocks(doc)) {
      const { plain, html, hasFormatting } = extractPptxRuns(block.p)
      if (!plain.trim()) continue

      const context = `Slide ${slideIndex + 1}`
      const segments = splitIntoSegments(plain)
      const sourceLocation = { file: slideFile, blockPath: block.blockPath }

      for (const seg of segments) {
        results.push({
          id: uuid(),
          original: seg.text,
          originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
          translated: "",
          context,
          group: seg.group,
          type: block.isTitle ? "heading" : "text",
          sourceLocation,
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
