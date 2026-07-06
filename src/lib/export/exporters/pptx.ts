// Client-side PPTX export with translation injection (FRO-152a).
//
// Mirrors the DOCX skeleton-injection exporter (./docx.ts): the server serves
// the raw PPTX side-car bytes; the client opens the zip with JSZip, walks the
// slide XML in the SAME order as the import parser (src/lib/parsers/pptx.ts —
// slides sorted numerically, then p:sp shapes, then a:p paragraphs, skipping
// paragraphs whose a:r run text is empty), and substitutes translations
// paragraph-by-paragraph.
//
// Fidelity levels:
//   1. Slide/shape/paragraph STRUCTURE is fully preserved — only a:t text
//      nodes are touched, never elements.
//   2. The FIRST run's character formatting (a:rPr — bold, italic, size,
//      font, colour) is preserved on the injected text, since the translation
//      is written into that run's existing a:t node.
//   3. MIXED-FORMAT paragraphs (multiple differently-formatted runs) collapse
//      to the first run's formatting: subsequent a:t nodes have their text
//      set to "" but the run ELEMENTS remain in place (so run counts and any
//      non-text children survive round-trips).
//
// Untranslated paragraphs are left byte-for-byte semantically unchanged.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"

export interface PptxExportResult {
  blob: Blob
  /** Number of paragraphs that received a translation. */
  injected: number
  /** Number of paragraphs that were left as-is (no translation). */
  untouched: number
  /** Translated paragraphs whose source had mixed run formatting keep only
   *  the first run's styling — surfaced per segment (additive field). */
  warnings: { segment: string; detail: string }[]
}

/**
 * Takes the raw PPTX bytes (fetched from the server side-car) and a list of
 * source cells with their translations. Injects translations back into
 * ppt/slides/slideN.xml by matching paragraphs in deck order.
 *
 * Cell ordering: cells are provided in deck order (the order the parser
 * emitted them). Each unique `group` value corresponds to one source
 * paragraph; multiple cells sharing a `group` are segments of the same
 * paragraph and are joined with a space (same rule as exportDocx).
 *
 * Paragraphs are matched positionally: the Nth non-empty paragraph across the
 * deck (slides numerically, shapes and paragraphs in document order — exactly
 * the traversal of extractPptxStrings) maps to the Nth unique group.
 * Untranslated groups (empty `translated`) leave the paragraph unchanged.
 */
export async function exportPptx(
  rawPptxBytes: ArrayBuffer,
  cells: CellData[],
): Promise<PptxExportResult> {
  const zip = await JSZip.loadAsync(rawPptxBytes)

  // Slide files in numeric order — identical to extractPptxStrings.
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0")
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0")
      return numA - numB
    })

  if (slideFiles.length === 0) {
    throw new Error("Malformed PPTX: no ppt/slides/slideN.xml parts found in side-car")
  }

  // Build a map: group → joined translation text, preserving first-seen order.
  const groupOrder: string[] = []
  const groupToTranslation = new Map<string, string>()

  for (const cell of cells) {
    if (!groupToTranslation.has(cell.group)) {
      groupOrder.push(cell.group)
      groupToTranslation.set(cell.group, "")
    }
    if (cell.translated.trim()) {
      const existing = groupToTranslation.get(cell.group) ?? ""
      groupToTranslation.set(
        cell.group,
        existing ? `${existing} ${cell.translated.trim()}` : cell.translated.trim(),
      )
    }
  }

  let injected = 0
  let untouched = 0
  const warnings: { segment: string; detail: string }[] = []
  // Running index of non-empty paragraphs across the whole deck.
  let paraCursor = 0

  const parser = new DOMParser()
  const serializer = new XMLSerializer()

  for (const slideFile of slideFiles) {
    const xmlStr = await zip.file(slideFile)!.async("string")
    const doc = parser.parseFromString(xmlStr, "application/xml")

    const shapes = doc.getElementsByTagName("p:sp")
    let slideMutated = false

    for (let spIdx = 0; spIdx < shapes.length; spIdx++) {
      const paragraphs = shapes[spIdx].getElementsByTagName("a:p")

      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const p = paragraphs[pIdx]
        // Skip-empty rule mirrors the parser: only text inside a:r runs counts.
        if (!paragraphPlainText(p).trim()) continue

        const group = groupOrder[paraCursor]
        paraCursor++
        if (!group) {
          untouched++
          continue
        }
        const translation = groupToTranslation.get(group) ?? ""
        if (!translation) {
          untouched++
          continue
        }

        if (countDistinctRunFormats(p) > 1) {
          warnings.push({
            segment: group,
            detail:
              "slide paragraph had mixed inline formatting; translation keeps only the first run's styling",
          })
        }
        if (injectTranslationIntoParagraph(p, translation)) {
          injected++
          slideMutated = true
        } else {
          untouched++
        }
      }
    }

    if (slideMutated) {
      // ECMA-376 producers (PowerPoint included) write empty text runs as
      // paired <a:t></a:t>, not self-closing — normalize so downstream
      // structural tooling sees the same element count as the original.
      zip.file(slideFile, serializer.serializeToString(doc).replace(/<a:t\s*\/>/g, "<a:t></a:t>"))
    }
  }

  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  })

  return { blob, injected, untouched, warnings }
}

/**
 * Concatenated run text of a paragraph — the exact non-empty test the import
 * parser applies (extractPptxRuns): only a:t nodes inside a:r runs count.
 */
function paragraphPlainText(p: Element): string {
  const runs = p.getElementsByTagName("a:r")
  let plain = ""
  for (let i = 0; i < runs.length; i++) {
    const textEls = runs[i].getElementsByTagName("a:t")
    for (let j = 0; j < textEls.length; j++) {
      plain += textEls[j].textContent || ""
    }
  }
  return plain
}

/**
 * Put the translated text into the paragraph's FIRST a:t element (its run's
 * a:rPr formatting is untouched, so it carries over) and blank the text of
 * every subsequent a:t in the paragraph. Elements are never removed — run
 * structure survives, only the visible text becomes exactly the translation.
 *
 * Returns false when the paragraph has no a:t node to write into (cannot
 * happen for paragraphs the parser deemed non-empty, but guarded anyway).
 */
function injectTranslationIntoParagraph(p: Element, text: string): boolean {
  const textEls = p.getElementsByTagName("a:t")
  if (textEls.length === 0) return false
  textEls[0].textContent = text
  for (let i = 1; i < textEls.length; i++) {
    textEls[i].textContent = ""
  }
  return true
}

/** Count distinct run-format signatures among a paragraph's text-bearing
 *  a:r runs (serialized a:rPr, "" when absent) — >1 means injection keeps
 *  only the first run's styling. */
function countDistinctRunFormats(p: Element): number {
  const runs = p.getElementsByTagName("a:r")
  const formats = new Set<string>()
  const serializer = new XMLSerializer()
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const t = run.getElementsByTagName("a:t")[0]
    if (!t?.textContent?.trim()) continue
    const rpr = run.getElementsByTagName("a:rPr")[0]
    formats.add(rpr ? serializer.serializeToString(rpr) : "")
  }
  return formats.size
}
