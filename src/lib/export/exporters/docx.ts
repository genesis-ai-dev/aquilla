// Client-side DOCX export with translation injection.
//
// FRO-233: Export formats that preserve paragraph/heading structure from the
// imported DOCX side-car. The server-side export route serves the raw DOCX
// bytes for files with format="docx" (X-Export-Mode: raw-sidecar). The client
// then uses JSZip to open the DOCX, substitutes translations paragraph-by-
// paragraph, and produces a new .docx file.
//
// Fidelity: paragraph/heading STRUCTURE is preserved (w:p elements, styles).
// Per-run bold/italic/underline formatting inside translated paragraphs is
// DROPPED — the translation is injected as a single <w:r> replacing all runs.
// This is an intentional trade-off: formatting the source had may not apply to
// the translated text, and re-distributing translation text back across the
// original run structure is not tractable without knowing how the translated
// text maps to the original runs. Untranslated paragraphs keep their original
// runs untouched.
//
// What is NOT achievable in this slice:
// - Per-run formatting preservation for translated paragraphs (only one run per para)
// - PPTX (separate issue FRO-152a)
// - Files > 512 KB at import time (no side-car stored; falls back to 501)
//
// HONESTY: this does not fully meet "export preserves formatting" for inline
// bold/italic on translated paragraphs. It meets the structural claim
// (headings, paragraph order) and is a meaningful improvement over the plain
// text lossy formats.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

export interface DocxExportResult {
  blob: Blob
  /** Number of paragraphs that received a translation. */
  injected: number
  /** Number of paragraphs that were left as-is (no translation). */
  untouched: number
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

  return { blob, injected, untouched }
}

/**
 * Replace all <w:r> runs in a paragraph with a single run containing the
 * translated text. Preserves <w:pPr> (style) but does not attempt to restore
 * per-run formatting — this is the documented fidelity limitation.
 */
function injectTranslationIntoParagraph(p: Element, text: string): void {
  const doc = p.ownerDocument!

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

  // Create a new run: <w:r><w:t xml:space="preserve">...</w:t></w:r>
  const run = doc.createElementNS(W_NS, "w:r")
  const t = doc.createElementNS(W_NS, "w:t")
  t.setAttribute("xml:space", "preserve")
  t.textContent = text
  run.appendChild(t)
  p.appendChild(run)
}
