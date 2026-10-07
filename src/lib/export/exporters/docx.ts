// Client-side DOCX export with translation injection — SURGICAL STRING APPROACH.
//
// ## Approach: surgical string-level run reinsertion (codex-editor parity)
//
// This exporter deliberately does NOT parse `word/document.xml` with DOMParser and
// reserialize the whole document with XMLSerializer. Full reserialisation produces
// blank rendering in Apple Pages because XMLSerializer injects `xmlns:w="…"` namespace
// declarations on every spliced fragment. The mature codex-editor desktop app
// (webviews/.../importers/docx/docxExporter.ts) discovered this and instead does
// surgical string-level replacement of paragraph content, leaving every other byte
// in the XML byte-for-byte identical. We mirror that strategy here.
//
// Only the run region of *translated* paragraphs changes; the XML declaration,
// namespace declarations, w:pPr, untranslated paragraphs, and all non-document.xml
// zip parts are byte-identical between input and output.
//
// We EXCEED codex-editor by rebuilding runs from the translator's own `translatedHtml`
// (codex-editor kept source-run formatting). The contract: translator's inline styling
// wins. htmlToSpans() → spansToRunXml() produces clean OOXML run strings without any
// xmlns pollution, which are spliced in as raw strings — no DOM serialization involved.
//
// ## Alternative (not used): DOM rebuild
//
// A simpler approach is to DOMParser.parseFromString the XML, mutate the DOM,
// and XMLSerializer.serializeToString it back. The Element-based `spansToRuns` in
// `docx-runs.ts` is the primitive that approach would use and is retained there for
// reference. It is NOT used here because of the Apple Pages blank-render bug above.
//
// ## AQU-233: DOCX round-trip fidelity
//
// Fidelity levels achieved with this approach:
//   1. Paragraph/heading STRUCTURE preserved (w:p elements, w:pStyle, w:pPr).
//   2. Dominant run character formatting (first text-run's w:rPr) preserved on
//      all injected runs (bold, italic, font-size, font-family, …).
//   3. Translator's INLINE markup (bold, italic, underline, strikethrough from
//      translatedHtml) is rebuilt run-by-run — translator formatting wins.
//   4. Untranslated paragraphs and all other zip parts are byte-identical.
//
// Fidelity report (warnings): a source paragraph that carried MIXED run formatting
// (multiple distinct w:rPr signatures across its text-bearing runs) is re-injected
// with only the dominant (first) run's rPr as the base. That source-side simplification
// is surfaced per-segment via the `warnings` array so the export UI can tell users
// which segments were flattened. (Consumed by ExportDialog's inline-style fidelity band.)
//
// What is NOT achievable in this slice:
// - PPTX (separate issue AQU-152a)
// - Files > 512 KB at import time (no side-car stored; falls back to 501)

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { htmlToSpans, spansToRunXml } from "./docx-runs"
import {
  packageBlockKey,
  translationsByPackageBlock,
  removedPackageBlockKeys,
  insertionsAfterPackageBlock,
  type RemovedCellLocatorSource,
} from "../import-locators"
import { isUserAddedLine } from "@/lib/timeline/user-line-origin"

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export interface DocxExportResult {
  blob: Blob
  /** Number of paragraphs that received a translation. */
  injected: number
  /** Number of paragraphs that were left as-is (no translation). */
  untouched: number
  /** AQU-1068: paragraphs dropped because their cell was removed in the app. */
  removed: number
  /** AQU-1068: new paragraphs written for cells added in the app. */
  inserted: number
  /** Per-paragraph inline-style warnings: translated paragraphs whose source
   *  had MIXED run formatting keep only the dominant run's styling as the base —
   *  surfaced so users know the output was simplified (additive field). */
  warnings: { segment: string; detail: string }[]
}

/**
 * Takes the raw DOCX bytes (fetched from the server side-car) and a list of
 * source cells with their translations. Injects translations back into
 * word/document.xml by the reversible package-block locator retained at import.
 *
 * Cell ordering: cells are provided in document order. Each unique `group`
 * value corresponds to one source paragraph. Multiple cells with the same
 * `group` are segments of the same paragraph and are joined with a space.
 *
 * Legacy cells without normalized locators retain a positional compatibility
 * fallback; normalized cells never fall back, preventing a reordered/deleted
 * cell from shifting translations into the wrong paragraph.
 *
 * A paragraph is "non-empty" iff its inner content contains a `<w:t…>…</w:t>`
 * with non-whitespace text.
 */
/**
 * The legacy, LOCATOR-LESS mapping: cells to document paragraphs by POSITION,
 * grouped by canonical ref. Files imported before package locators existed have
 * only this, which makes the array's contents load-bearing — every entry is a
 * paragraph slot in the client's own document.
 *
 * Exported so the added-line guard below can be tested directly; the positional
 * path is otherwise only reachable through a whole .docx package.
 */
export function buildLegacyGroups(cells: CellData[]): {
  groups: string[]
  groupToData: Map<string, { html: string; plain: string }>
} {
  const groups: string[] = []
  const groupToData = new Map<string, { html: string; plain: string }>()
  for (const cell of cells) {
    // AQU-1068: a line somebody ADDED here has no paragraph in the original
    // package, so letting it consume a slot shifts every mapping after it and
    // writes translations into the WRONG paragraphs of the client's document.
    // Locator-based files are already immune — an added line has no locator, so
    // `translationsByPackageBlock` skips it. This is the positional path's guard.
    if (isUserAddedLine(cell)) continue
    const legacyGroup = cell.group || cell.id
    if (!groupToData.has(legacyGroup)) {
      groups.push(legacyGroup)
      groupToData.set(legacyGroup, { html: "", plain: "" })
    }
    const data = groupToData.get(legacyGroup)!
    if (cell.translated?.trim()) {
      const prev = data.plain
      data.plain = prev ? `${prev} ${cell.translated.trim()}` : cell.translated.trim()
    }
    if (cell.translatedHtml?.trim()) {
      const prev = data.html
      data.html = prev ? `${prev} ${cell.translatedHtml.trim()}` : cell.translatedHtml.trim()
    }
  }
  return { groups, groupToData }
}

export interface DocxExportOptions {
  /** AQU-1068: source cells this file has LOST, from the server's event log
   *  (`fetchRemovedCells`). Their paragraphs leave the document. Without this
   *  a removed paragraph is indistinguishable from an untranslated one and the
   *  removal is silently undone. */
  removedCells?: readonly RemovedCellLocatorSource[]
}

export async function exportDocx(
  rawDocxBytes: ArrayBuffer,
  cells: CellData[],
  options: DocxExportOptions = {},
): Promise<DocxExportResult> {
  const zip = await JSZip.loadAsync(rawDocxBytes)

  const xml = await zip.file("word/document.xml")?.async("string")
  if (!xml) {
    throw new Error("Malformed DOCX: word/document.xml not found in side-car")
  }

  const { groups, groupToData } = buildLegacyGroups(cells)
  const locatedTranslations = translationsByPackageBlock(cells)
  const hasLocatedTranslations = locatedTranslations.size > 0
  // AQU-1068. BOTH lookups are built BEFORE the package walk, which is the
  // point of the guard in buildLegacyGroups: an added cell that consumed a
  // positional slot would shift every mapping after it and write translations
  // into the wrong paragraphs of the client's document.
  const removedKeys = removedPackageBlockKeys(options.removedCells ?? [])
  const insertions = insertionsAfterPackageBlock(cells, isUserAddedLine)

  // Surgical paragraph scan: match both full <w:p …>…</w:p> and self-closing <w:p …/>.
  // We do NOT use DOMParser/XMLSerializer — raw string splice only.
  //
  // CRITICAL: the two forms are MUTUALLY EXCLUSIVE alternatives; self-closing MUST come
  // first. The previous combined form `<w:p\b[^>]*\/?>(?:…</w:p>)?` was broken: for
  // `<w:p/><w:p>Real</w:p>` the optional group would match forward to the NEXT </w:p>,
  // fusing both paragraphs into one token and dropping "Real".
  const paraRegex = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g

  let rebuilt = ""
  let lastIndex = 0
  let nonEmptyIdx = 0
  let paragraphIndex = 0
  let injected = 0
  let untouched = 0
  let removed = 0
  let inserted = 0
  const warnings: { segment: string; detail: string }[] = []
  let match: RegExpExecArray | null

  /**
   * AQU-1068: write out any cells added UNDER this paragraph, as new
   * paragraphs of their own in the anchor's style.
   *
   * Cheap because the rebuild is plain string concatenation and
   * `paragraphIndex` is driven by the INPUT scan — an inserted paragraph
   * cannot shift a later locator, which is what makes this safe here and not
   * in the positional fallback path.
   */
  function appendInsertions(blockKey: string, anchorXml: string): void {
    const texts = insertions.get(blockKey)
    if (!texts || texts.length === 0) return
    const anchorInner = anchorXml.includes("</w:p>") ? extractInner(anchorXml) : ""
    const pPrXml = extractPPr(anchorInner)
    const afterPPr = pPrXml ? anchorInner.slice(anchorInner.indexOf(pPrXml) + pPrXml.length) : anchorInner
    const baseRprXml = extractFirstRunRpr(afterPPr)
    const openTag = anchorXml.includes("</w:p>") ? extractOpenTag(anchorXml) : "<w:p>"
    for (const text of texts) {
      const spans = htmlToSpans(text)
      const effective = spans.length > 0
        ? spans
        : [{ text, marks: new Set<import("./docx-runs").Mark>() }]
      rebuilt += `${openTag}${pPrXml}${spansToRunXml(effective, baseRprXml)}</w:p>`
      inserted++
    }
  }

  while ((match = paraRegex.exec(xml)) !== null) {
    const full = match[0]
    paragraphIndex++
    const matchStart = match.index

    // Copy the slice before this match verbatim.
    rebuilt += xml.slice(lastIndex, matchStart)
    lastIndex = matchStart + full.length

    // Determine if this is a self-closing paragraph (no inner content).
    // With the mutually-exclusive regex, self-closing matches never contain </w:p>.
    const isSelfClosing = !full.includes("</w:p>")
    const inner = isSelfClosing ? "" : extractInner(full)

    // A paragraph is non-empty iff it has a <w:t …>…</w:t> with non-whitespace text.
    const isEmpty = !/<w:t[^>]*>([^<]*)<\/w:t>/.test(inner) ||
      !inner.match(/<w:t[^>]*>([^<]*)<\/w:t>/g)?.some(m => {
        const textMatch = m.match(/<w:t[^>]*>([^<]*)<\/w:t>/)
        return textMatch && textMatch[1].trim().length > 0
      })

    if (isEmpty) {
      // Empty paragraph: pass through unchanged, do not increment nonEmptyIdx.
      rebuilt += full
      continue
    }

    // Normalized imports address the exact source paragraph. Only legacy rows
    // use the positional group fallback.
    const blockKey = packageBlockKey("word/document.xml", `w:p[${paragraphIndex}]`)
    const located = locatedTranslations.get(blockKey)
    const group = groups[nonEmptyIdx]
    nonEmptyIdx++

    // AQU-1068: this paragraph's cell was REMOVED. Emit nothing at all — the
    // paragraph leaves the document. `paragraphIndex` counts the INPUT scan, so
    // every later locator still resolves; nothing shifts.
    if (removedKeys.has(blockKey)) {
      removed++
      continue
    }

    if (!located && (hasLocatedTranslations || !group)) {
      rebuilt += full
      untouched++
      appendInsertions(blockKey, full)
      continue
    }

    const data = located ?? groupToData.get(group as string)!
    // Use html if available, fall back to plain text. Skip if both empty.
    const html = data.html || data.plain
    if (!html) {
      rebuilt += full
      untouched++
      appendInsertions(blockKey, full)
      continue
    }

    // Extract the leading pPr block verbatim (the paragraph's style/spacing).
    const pPrXml = extractPPr(inner)

    // Extract baseRprXml: the FIRST TEXT-RUN's <w:rPr>…</w:rPr> from the inner
    // content AFTER the pPr block (NOT the paragraph-mark rPr inside pPr).
    const innerAfterPPr = pPrXml ? inner.slice(inner.indexOf(pPrXml) + pPrXml.length) : inner
    const baseRprXml = extractFirstRunRpr(innerAfterPPr)

    // Fidelity report: if the source paragraph carried more than one distinct
    // run-format signature, injection collapses it to the dominant run's rPr as
    // the base. Surface that per-segment so the export UI can flag it.
    if (countDistinctRunFormats(innerAfterPPr) > 1) {
      warnings.push({
        segment: located?.label ?? group ?? "unknown paragraph",
        detail:
          "paragraph had mixed inline formatting; translation keeps only the first run's styling",
      })
    }

    // Build the translated runs from translatedHtml (or plain text as fallback).
    const spans = htmlToSpans(html)
    const effectiveSpans = spans.length > 0
      ? spans
      : [{ text: data.plain || html, marks: new Set<import("./docx-runs").Mark>() }]
    const runsXml = spansToRunXml(effectiveSpans, baseRprXml)

    // Extract the open tag (attributes) of the original <w:p …>.
    const openTag = extractOpenTag(full)

    // Reconstruct: open tag + pPr (verbatim) + new runs + close tag.
    rebuilt += `${openTag}${pPrXml}${runsXml}</w:p>`
    injected++
    appendInsertions(blockKey, full)
  }

  // Append any trailing content after the last paragraph match.
  rebuilt += xml.slice(lastIndex)

  // Write modified XML back — only word/document.xml changes; all other parts untouched.
  zip.file("word/document.xml", rebuilt)

  // AQU-889: DEFLATE, not JSZip's default STORE. A re-zipped package that
  // stores every part uncompressed balloons an ~10KB Word document to ~200KB
  // for a two-line edit — the delta was never the problem, the packaging was.
  // Level 6 matches the convention in `src/lib/import/file-entries.ts`.
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: DOCX_MIME,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  return { blob, injected, untouched, removed, inserted, warnings }
}

/** Extract the content between the opening and closing w:p tags. */
function extractInner(fullMatch: string): string {
  // Find the first >, then take everything up to (but not including) </w:p>.
  const openEnd = fullMatch.indexOf(">")
  if (openEnd === -1) return ""
  const closeStart = fullMatch.lastIndexOf("</w:p>")
  if (closeStart === -1) return ""
  return fullMatch.slice(openEnd + 1, closeStart)
}

/** Extract the opening tag of a w:p element (e.g., `<w:p w:rsidR="…">`). */
function extractOpenTag(fullMatch: string): string {
  const openEnd = fullMatch.indexOf(">")
  if (openEnd === -1) return "<w:p>"
  return fullMatch.slice(0, openEnd + 1)
}

/**
 * Extract the leading <w:pPr>…</w:pPr> block from paragraph inner content.
 * Returns the verbatim XML string (including the tags), or "" if not present.
 */
function extractPPr(inner: string): string {
  // Match leading whitespace + pPr element (full or self-closing).
  const m = inner.match(/^[\s]*<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>|^[\s]*<w:pPr\b[^>]*\/>/)
  return m ? m[0] : ""
}

/**
 * Extract the <w:rPr>…</w:rPr> from the FIRST text-bearing <w:r> element in
 * `innerAfterPPr`. A run is "text-bearing" iff it contains a <w:t> with
 * non-whitespace text. Runs that contain only bookmarks, <w:br/>, or other
 * non-text elements are skipped so their (often absent) rPr does not falsely
 * become the dominant character format.
 *
 * Returns null if no text-bearing run is found, or if the first such run has no rPr.
 */
function extractFirstRunRpr(innerAfterPPr: string): string | null {
  // Iterate over all <w:r …>…</w:r> runs in order.
  const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g
  let runMatch: RegExpExecArray | null
  while ((runMatch = runRegex.exec(innerAfterPPr)) !== null) {
    const runContent = runMatch[0]

    // Skip runs without non-whitespace text content.
    const tMatch = runContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/)
    if (!tMatch || !tMatch[1].trim()) continue

    // This is the first text-bearing run — extract its rPr.
    const rPrMatch = runContent.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/)
    if (rPrMatch) return rPrMatch[0]

    // Also handle self-closing <w:rPr/>.
    const rPrSelf = runContent.match(/<w:rPr\b[^>]*\/>/)
    if (rPrSelf) return rPrSelf[0]

    // First text-bearing run has no rPr.
    return null
  }

  return null
}

/**
 * Count distinct run-format signatures among a paragraph's text-bearing runs.
 *
 * Scans every `<w:r>…</w:r>` in `innerAfterPPr` (the paragraph content after the
 * pPr block), and for each run that carries non-whitespace `<w:t>` text records
 * its `<w:rPr>` string (or "" when the run has no rPr). More than one distinct
 * signature means the source paragraph mixed run formatting, which the surgical
 * injection flattens to the dominant run's rPr — the caller emits a fidelity
 * warning for that segment. String-based (no DOM) to match the exporter approach.
 */
function countDistinctRunFormats(innerAfterPPr: string): number {
  const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g
  const formats = new Set<string>()
  let run: RegExpExecArray | null
  while ((run = runRegex.exec(innerAfterPPr)) !== null) {
    const runXml = run[0]
    // Only consider runs with non-whitespace text.
    const hasText = runXml
      .match(/<w:t[^>]*>([^<]*)<\/w:t>/g)
      ?.some(m => {
        const textMatch = m.match(/<w:t[^>]*>([^<]*)<\/w:t>/)
        return textMatch && textMatch[1].trim().length > 0
      })
    if (!hasText) continue
    const rPrMatch = runXml.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>/)
    formats.add(rPrMatch ? rPrMatch[0] : "")
  }
  return formats.size
}
