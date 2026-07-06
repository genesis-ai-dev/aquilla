// Client-side DOCX export with translation injection.
//
// FRO-233: Export formats that preserve paragraph/heading structure from the
// imported DOCX side-car. The server-side export route serves the raw DOCX
// bytes for files with format="docx" (X-Export-Mode: raw-sidecar). The client
// then uses JSZip to open the DOCX, substitutes translations paragraph-by-
// paragraph, and produces a new .docx file.
//
// Fidelity levels:
//   1. Paragraph/heading STRUCTURE is preserved (w:p elements, w:pStyle).
//   2. DOMINANT RUN character formatting (w:rPr) is preserved on the injected
//      run — bold, italic, underline, font-size, font family etc. survive at
//      the level of the paragraph's first/dominant run.
//   3. MIXED-FORMAT paragraphs (multiple differently-formatted runs) are
//      collapsed to a single run carrying the dominant run's formatting.
//
// SWARM-TODO (FRO-233): Mixed-format paragraphs — a paragraph with e.g.
//   "Hello <bold>world</bold> today" contains two differently-formatted runs.
//   After injection the entire translated paragraph gets the first run's rPr,
//   so the bold mid-paragraph emphasis is lost. Fixing this requires tracking a
//   per-run text→format map at import time and storing it alongside the cells
//   so the exporter can reconstruct a multi-run paragraph. That work is
//   deferred. Untranslated paragraphs keep ALL their original runs untouched.
//
// What is NOT achievable in this slice:
// - Mixed-format per-run preservation within a single translated paragraph
//   (see SWARM-TODO above)
// - PPTX (separate issue FRO-152a)
// - Files > 512 KB at import time (no side-car stored; falls back to 501)
//
// HONESTY: this does not fully meet "export preserves formatting" for mixed
// inline bold/italic on translated paragraphs. It DOES meet the structural
// claim (headings, paragraph order) and preserves dominant run character
// formatting (bold, italic, font) — a meaningful improvement over the previous
// complete-drop behaviour.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

export interface DocxExportResult {
  blob: Blob
  /** Number of paragraphs that received a translation. */
  injected: number
  /** Number of paragraphs that were left as-is (no translation). */
  untouched: number
  /** Per-paragraph inline-style warnings: translated paragraphs whose source
   *  had MIXED run formatting keep only the dominant run's styling —
   *  surfaced so users know the output was simplified (additive field). */
  warnings: { segment: string; detail: string }[]
}

/**
 * Takes the raw DOCX bytes (fetched from the server side-car) and a list of
 * source cells with their translations. Injects translations back into
 * word/document.xml by matching paragraphs in document order.
 *
 * Cell ordering: cells are provided in document order. Each unique `group`
 * value corresponds to one source paragraph. Multiple cells with the same
 * `group` are segments of the same paragraph and are joined with a space.
 *
 * The DOCX paragraphs are matched positionally: the first non-empty paragraph
 * in the DOCX maps to the first unique group in cells, the second to the
 * second, and so on. Untranslated cells (empty `translated`) leave the
 * paragraph unchanged.
 */
export async function exportDocx(
  rawDocxBytes: ArrayBuffer,
  cells: CellData[],
): Promise<DocxExportResult> {
  const zip = await JSZip.loadAsync(rawDocxBytes)

  const xmlStr = await zip.file("word/document.xml")?.async("string")
  if (!xmlStr) {
    throw new Error("Malformed DOCX: word/document.xml not found in side-car")
  }

  // Build a map: group → joined translation text.
  // Groups appear in cells in document order; we preserve that order.
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

  // Parse XML.
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlStr, "application/xml")
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0]
    || doc.getElementsByTagName("w:body")[0]

  if (!body) {
    throw new Error("Malformed DOCX: w:body not found in document.xml")
  }

  const paragraphs = Array.from(doc.getElementsByTagName("w:p"))

  // Filter to non-empty paragraphs (mirrors the import parser's skip-empty logic).
  const nonEmptyParas = paragraphs.filter((p) => {
    const runs = p.getElementsByTagName("w:r")
    for (let i = 0; i < runs.length; i++) {
      const textEls = runs[i].getElementsByTagName("w:t")
      for (let j = 0; j < textEls.length; j++) {
        if (textEls[j].textContent?.trim()) return true
      }
    }
    return false
  })

  let injected = 0
  let untouched = 0
  const warnings: { segment: string; detail: string }[] = []

  // Match non-empty paragraphs to groups positionally.
  for (let i = 0; i < nonEmptyParas.length; i++) {
    const group = groupOrder[i]
    if (!group) {
      untouched++
      continue
    }
    const translation = groupToTranslation.get(group) ?? ""
    if (!translation) {
      untouched++
      continue
    }

    // Replace paragraph runs with a single run carrying the translated text.
    // We keep the w:pPr (paragraph properties = style) intact.
    const p = nonEmptyParas[i]
    if (countDistinctRunFormats(p) > 1) {
      warnings.push({
        segment: group,
        detail:
          "paragraph had mixed inline formatting; translation keeps only the first run's styling",
      })
    }
    injectTranslationIntoParagraph(p, translation)
    injected++
  }

  // Serialize back to XML string.
  const serializer = new XMLSerializer()
  const newXml = serializer.serializeToString(doc)

  // Write modified XML back into the zip.
  zip.file("word/document.xml", newXml)

  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  })

  return { blob, injected, untouched, warnings }
}

/** Count distinct run-format signatures among a paragraph's text-bearing runs
 *  (serialized w:rPr, "" for unformatted) — >1 means injection simplifies. */
function countDistinctRunFormats(p: Element): number {
  const runs = p.getElementsByTagName("w:r")
  const formats = new Set<string>()
  const serializer = new XMLSerializer()
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const textEls = run.getElementsByTagName("w:t")
    let hasText = false
    for (let j = 0; j < textEls.length; j++) {
      if (textEls[j].textContent?.trim()) {
        hasText = true
        break
      }
    }
    if (!hasText) continue
    const rpr = run.getElementsByTagName("w:rPr")[0]
    formats.add(rpr ? serializer.serializeToString(rpr) : "")
  }
  return formats.size
}

/**
 * Extract the dominant run's w:rPr element from a paragraph.
 *
 * "Dominant" = the first <w:r> that contains visible text. If no such run
 * exists (paragraph was empty or bookmarks only), returns null and the caller
 * will create a run with no character formatting.
 *
 * We use the *first text-bearing run* as the heuristic because:
 *  - Heading paragraphs in Word typically have uniform formatting on all runs.
 *  - Body paragraphs where the first word is formatted differently are unusual.
 *  - For mixed-format paragraphs this loses later runs' per-run formatting;
 *    see SWARM-TODO at the top of this file.
 */
function extractDominantRpr(p: Element): Element | null {
  const runs = p.getElementsByTagName("w:r")
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    // Only count runs that carry text content.
    const textEls = run.getElementsByTagName("w:t")
    let hasText = false
    for (let j = 0; j < textEls.length; j++) {
      if (textEls[j].textContent?.trim()) {
        hasText = true
        break
      }
    }
    if (!hasText) continue

    // Return the rPr child of this run if present.
    const rPrEls = run.getElementsByTagName("w:rPr")
    if (rPrEls.length > 0) {
      return rPrEls[0]
    }
    // First text run found but has no rPr — no character formatting to clone.
    return null
  }
  return null
}

/**
 * Replace all <w:r> runs in a paragraph with a single run containing the
 * translated text. Preserves:
 *   - <w:pPr> (paragraph/heading style, spacing, etc.)
 *   - The dominant run's <w:rPr> (bold, italic, font-size, font family, …)
 *
 * SWARM-TODO (FRO-233): For mixed-format paragraphs (multiple differently-
 * formatted runs) the entire translated paragraph receives only the dominant
 * (first text-bearing) run's rPr. Per-run inline formatting for non-dominant
 * runs is not preserved. See file header for details.
 */
function injectTranslationIntoParagraph(p: Element, text: string): void {
  const doc = p.ownerDocument!

  // Capture the dominant run's rPr BEFORE removing any runs.
  const dominantRpr = extractDominantRpr(p)

  // Collect all child nodes that are NOT w:pPr.
  const toRemove: Element[] = []
  const children = Array.from(p.childNodes)
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element
      const localName = el.localName || el.tagName.replace(/^.*:/, "")
      if (localName !== "pPr") {
        toRemove.push(el)
      }
    }
  }
  for (const el of toRemove) el.remove()

  // Create a new run: <w:r>[<w:rPr>…</w:rPr>]<w:t xml:space="preserve">…</w:t></w:r>
  const run = doc.createElementNS(W_NS, "w:r")

  // Clone and attach the dominant run's character formatting if present.
  if (dominantRpr) {
    run.appendChild(dominantRpr.cloneNode(true))
  }

  const t = doc.createElementNS(W_NS, "w:t")
  t.setAttribute("xml:space", "preserve")
  t.textContent = text
  run.appendChild(t)
  p.appendChild(run)
}
