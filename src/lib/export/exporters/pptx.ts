// Client-side PPTX export with translation injection (AQU-152a).
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
import {
  packageBlockKey,
  translationsByPackageBlock,
  removedPackageBlockKeys,
  insertionsAfterPackageBlock,
  type RemovedCellLocatorSource,
} from "../import-locators"
import { isUserAddedLine } from "@/lib/timeline/user-line-origin"

export interface PptxExportResult {
  blob: Blob
  /** Number of paragraphs that received a translation. */
  injected: number
  /** Number of paragraphs that were left as-is (no translation). */
  untouched: number
  /** AQU-1068: paragraphs dropped because their cell was removed in the app. */
  removed: number
  /** AQU-1068: new paragraphs written for cells added in the app. */
  inserted: number
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
 * Normalized imports match the exact package member + shape/paragraph path.
 * Legacy cells without locators keep the prior positional fallback.
 * Untranslated groups (empty `translated`) leave the paragraph unchanged.
 */
export interface PptxExportOptions {
  /** AQU-1068: source cells this file has LOST, from the server's event log
   *  (`fetchRemovedCells`). Their paragraphs leave the deck. */
  removedCells?: readonly RemovedCellLocatorSource[]
}

export async function exportPptx(
  rawPptxBytes: ArrayBuffer,
  cells: CellData[],
  options: PptxExportOptions = {},
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
    // AQU-1068: a line somebody ADDED here has no place in the original
    // package, and the legacy fallback below maps cells to paragraphs BY
    // POSITION — so letting one into this array shifts every mapping after it
    // and writes translations into the wrong paragraphs of the client's own
    // document. Locator-based files are already immune (an added line has no
    // locator, so it is simply skipped); this is the positional path's guard.
    if (isUserAddedLine(cell)) continue
    const legacyGroup = cell.group || cell.id
    if (!groupToTranslation.has(legacyGroup)) {
      groupOrder.push(legacyGroup)
      groupToTranslation.set(legacyGroup, "")
    }
    if (cell.translated.trim()) {
      const existing = groupToTranslation.get(legacyGroup) ?? ""
      groupToTranslation.set(
        legacyGroup,
        existing ? `${existing} ${cell.translated.trim()}` : cell.translated.trim(),
      )
    }
  }
  const locatedTranslations = translationsByPackageBlock(cells)
  const hasLocatedTranslations = locatedTranslations.size > 0
  // AQU-1068. Both built BEFORE the deck walk, for the reason the guard above
  // exists: a mapping computed while the tree is being mutated writes
  // translations into the wrong paragraphs of the client's own deck.
  const removedKeys = removedPackageBlockKeys(options.removedCells ?? [])
  const insertions = insertionsAfterPackageBlock(cells, isUserAddedLine)

  let injected = 0
  let untouched = 0
  let removed = 0
  let inserted = 0
  const warnings: { segment: string; detail: string }[] = []
  // Running index of non-empty paragraphs across the whole deck.
  let paraCursor = 0

  const parser = new DOMParser()
  const serializer = new XMLSerializer()

  /**
   * AQU-1068: write out cells added UNDER this paragraph, as new paragraphs of
   * their own cloned from the anchor — so the added text inherits the anchor's
   * run and paragraph properties rather than arriving unstyled.
   *
   * A PowerPoint text box does NOT reflow: its shape has a fixed extent, so a
   * slide can overflow and the added text may sit outside the visible box.
   * Sam's call (2026-09-09) is that this is the lesser failure — the content is
   * in the file and the client can resize the box, whereas content that never
   * arrives cannot be recovered at all — and the export dialog says a slide may
   * overflow.
   */
  function insertAfter(anchor: Element, blockKey: string): boolean {
    const texts = insertions.get(blockKey)
    if (!texts || texts.length === 0) return false
    let after: Element = anchor
    for (const text of texts) {
      const clone = anchor.cloneNode(true) as Element
      if (!injectTranslationIntoParagraph(clone, text)) continue
      after.parentNode?.insertBefore(clone, after.nextSibling)
      after = clone
      inserted++
    }
    return true
  }

  for (const slideFile of slideFiles) {
    const xmlStr = await zip.file(slideFile)!.async("string")
    const doc = parser.parseFromString(xmlStr, "application/xml")

    const shapes = doc.getElementsByTagName("p:sp")
    let slideMutated = false

    const shapeList = Array.from(shapes)
    for (let spIdx = 0; spIdx < shapeList.length; spIdx++) {
      // SNAPSHOT, because `getElementsByTagName` returns a LIVE collection and
      // this loop now inserts and removes paragraphs. Iterating the live list
      // while mutating it shifts `pIdx` and `length` underneath the walk, which
      // silently skips paragraphs — and the locator path indexes by `pIdx`, so
      // every translation after the first edit would land on the wrong one.
      const paragraphs = Array.from(shapeList[spIdx].getElementsByTagName("a:p"))

      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const p = paragraphs[pIdx]
        // Skip-empty rule mirrors the parser: only text inside a:r runs counts.
        if (!paragraphPlainText(p).trim()) continue

        const blockKey = packageBlockKey(
          slideFile,
          `p:sp[${spIdx + 1}]/p:txBody/a:p[${pIdx + 1}]`,
        )
        const located = locatedTranslations.get(blockKey)

        // AQU-1068: this paragraph's cell was removed in the app, so the
        // paragraph leaves the deck. The snapshot above means the removal
        // cannot disturb the indices this walk is built on.
        if (removedKeys.has(blockKey)) {
          p.parentNode?.removeChild(p)
          removed++
          slideMutated = true
          continue
        }

        const group = groupOrder[paraCursor]
        paraCursor++
        if (!located && (hasLocatedTranslations || !group)) {
          untouched++
          if (insertAfter(p, blockKey)) slideMutated = true
          continue
        }
        const translation = located?.plain ?? (group ? groupToTranslation.get(group) : undefined) ?? ""
        if (!translation) {
          untouched++
          if (insertAfter(p, blockKey)) slideMutated = true
          continue
        }

        if (countDistinctRunFormats(p) > 1) {
          warnings.push({
            segment: located?.label ?? group ?? "unknown paragraph",
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
        if (insertAfter(p, blockKey)) slideMutated = true
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

  return { blob, injected, untouched, removed, inserted, warnings }
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
