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
//
// ## AQU-2539: paragraphs are found, read and rebuilt the importer's way
//
// The old paragraph regex could not see a paragraph nested in another one (a
// text box), so it ended the outer paragraph at the inner `</w:p>`: every later
// translation landed one paragraph late and the output was not well-formed XML.
// Paragraphs now come from `scanDocxParagraphs` and their content from
// `walkDocxParagraph` (src/lib/parsers/docx-structure.ts), the same code the
// importer uses, so `w:p[N]` and "this paragraph's line" mean the same thing on
// both sides. A translated paragraph is rebuilt by ONE placement rule:
//
//   open tag + pPr, then everything that is not text and comes before the
//   paragraph's first word (bookmarks, field codes, pictures…), then the
//   translation, then everything else that is not text, in its original order.
//   A footnote reference goes where its USFM marker sits in the translation.
//   If one wrapper (a hyperlink, a content control…) holds all of the text, the
//   translation is written inside it and the rest of the paragraph is untouched.
//
// Every non-text piece is copied byte for byte from the source. Paragraphs in a
// text box are rendered in place inside the run that holds the box.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import {
  directRprChild,
  htmlToSpans,
  rPrWithLanguage,
  rPrWithMarks,
  textRunXml,
  type Mark,
  type Span,
} from "./docx-runs"
import { frenchSpacing, isFrenchLanguage } from "./french-spacing"
import { anchorCounts, rebuildParagraphInner, type RebuildIo, type RebuildResult } from "./docx-rebuild"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import { createUsfmFootnoteMarker } from "@/lib/footnotes/insert"
import {
  packageBlockKey,
  translationsByPackageBlock,
  positionalBlockParts,
  positionalLines,
  type BlockPart,
  removedPackageBlockKeys,
  insertionsAfterPackageBlock,
  type RemovedCellLocatorSource,
} from "../import-locators"
import { isUserAddedLine } from "@/lib/timeline/user-line-origin"
import {
  docxLine,
  flattenPieces,
  hiddenRunTest,
  linePieceFlags,
  readDocxStyleSheet,
  scanDocxParagraphs,
  walkDocxParagraph,
  type DocxParagraphSpan,
  type DocxPiece,
  type DocxWalkContext,
} from "@/lib/parsers/docx-structure"
import { loadFootnotes } from "@/lib/parsers/docx"
import {
  assertWellFormedXml,
  elementsByTagName,
  getAttribute,
  isElement,
  parseXmlLite,
  type XmlElement,
} from "@/lib/parsers/xml-lite"

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const DOCUMENT_PART = "word/document.xml"
const FOOTNOTES_PART = "word/footnotes.xml"
const STYLES_PART = "word/styles.xml"

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
  /** What the export could not write and a re-import of the file would fix
   *  (an old import's text boxes), each naming its paragraph by first words. */
  warnings: { segment: string; detail: string }[]
  /** AQU-2539: translated paragraphs where words with a look of their own
   *  (bold, italic, a colour…) are not in the translation, so the translation
   *  took the paragraph's main look there: each paragraph by its first words,
   *  with the first words of each such stretch as the source has them. A
   *  paragraph whose every such stretch is found unchanged keeps its looks and
   *  is not listed. */
  lostLooks: { segment: string; words: string[] }[]
  /** AQU-2539: what the rebuild of translated paragraphs kept and lost, over
   *  the whole file (see docx-rebuild.ts). Additive field. */
  fidelity: DocxExportFidelity
}

export interface DocxExportFidelity {
  /** Stretches with their own look found unchanged in a translation. */
  keptLooks: number
  /** Fields and links rebuilt around their unchanged text. */
  keptFields: number
  keptLinks: number
  /** Fields written with an empty result; links dropped (their words stay). */
  emptiedFields: number
  droppedLinks: number
  /** Footnotes whose translated text was written into word/footnotes.xml, and
   *  translated notes left in the source language (several paragraphs). */
  notesWritten: number
  notesLeft: number
  /** Paragraphs with words of their own holding a text box whose cell (from
   *  before AQU-2539) also holds the box's words: left as they are, with a
   *  warning to re-import. */
  staleTextBoxHolders: number
  /** Text-box paragraphs with no translation of their own that took an old
   *  cell's: their stored copy's, or the holder's when it was their words
   *  repeated. */
  textBoxCellsAdopted: number
  /** Text-box paragraphs left without a translation because an old cell held
   *  their words and could not be given to them (each named in a warning). */
  textBoxCellsNotSplit: number
  /** Footnote markers the translation added where the source had no
   *  footnote: not written (the marker text never reaches the body). */
  unplacedFootnoteMarkers: number
}

/** One paragraph's translation: its segments in order, with their sources. */
interface ParagraphTranslation {
  parts: { plain: string; html: string; source?: string; untranslated?: true }[]
  label: string
  /** Every segment's source, translated or not. */
  source: string
  /** AQU-2552 (review r6): the paragraph lost a line, hidden or deleted. What
   *  of its text no remaining line holds was that line's, and is left out. */
  lostLines?: true
}

interface LegacyGroup {
  parts: BlockPart[]
  source: string
}

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
  groupToData: Map<string, LegacyGroup>
} {
  const groupToData = new Map<string, LegacyGroup>()
  // AQU-1068: a line somebody ADDED here has no paragraph in the original
  // package, so letting it consume a slot shifts every mapping after it and
  // writes translations into the WRONG paragraphs of the client's document.
  // Locator-based files are already immune — an added line has no locator, so
  // `translationsByPackageBlock` skips it. positionalLines is the positional
  // path's guard (and AQU-2552 review r6: it keeps a split piece in its line's
  // paragraph).
  const groupCells = positionalLines(cells)
  const groups = [...groupCells.keys()]
  for (const [group, list] of groupCells) {
    // AQU-2552 (review r6): a hidden line keeps its original text on such a file.
    groupToData.set(group, { parts: positionalBlockParts(list), source: list.map((cell) => cell.original ?? "").join(" ") })
  }
  return { groups, groupToData }
}

export interface DocxExportOptions {
  /** AQU-1068: source cells this file has LOST, from the server's event log
   *  (`fetchRemovedCells`). Their paragraphs leave the document. Without this
   *  a removed paragraph is indistinguishable from an untranslated one and the
   *  removal is silently undone. */
  removedCells?: readonly RemovedCellLocatorSource[]
  /** AQU-2539: the target language as a BCP 47 code ("fr", "fr-FR"), when the
   *  project knows one. Translated runs get it as their proofing language, and
   *  French gets its no-break spaces (french-spacing.ts). Unknown: neither. */
  targetLanguage?: string | null
}

/**
 * Does this paragraph's XML hold any non-blank `w:t` at all (nested text boxes
 * included)? This is the line rule of the importer BEFORE AQU-2539, and so the
 * slot rule of the positional (locator-less) path, whose cells it made — and
 * the condition under which a removed cell removes its paragraph, as before.
 */
function hasAnyText(xml: string, span: DocxParagraphSpan): boolean {
  if (span.selfClosing) return false
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
  const slice = xml.slice(span.start, span.end)
  let m: RegExpExecArray | null
  while ((m = re.exec(slice)) !== null) {
    if (m[1].trim().length > 0) return true
  }
  return false
}

export async function exportDocx(
  rawDocxBytes: ArrayBuffer,
  cells: CellData[],
  options: DocxExportOptions = {},
): Promise<DocxExportResult> {
  // createFolders: false — JSZip otherwise adds a "word/" folder entry the
  // client's package never had (AQU-2539: the export had one part too many).
  const zip = await JSZip.loadAsync(rawDocxBytes, { createFolders: false })

  const xml = await zip.file(DOCUMENT_PART)?.async("string")
  if (!xml) {
    throw new Error("Malformed DOCX: word/document.xml not found in side-car")
  }
  const footnotesXml = await zip.file(FOOTNOTES_PART)?.async("string")
  const stylesXml = await zip.file(STYLES_PART)?.async("string")
  const walkContext: DocxWalkContext = {
    footnotes: footnotesXml ? loadFootnotes(footnotesXml) : new Map(),
    // AQU-2539: hidden runs are never rewritten. A wholly hidden paragraph has
    // no visible words, so it is left byte-identical even when an old import
    // holds a cell (and a translation) for it.
    isHiddenRun: hiddenRunTest(readDocxStyleSheet(stylesXml ? parseXmlLite(stylesXml) : undefined)),
  }

  const { groups, groupToData } = buildLegacyGroups(cells)
  const locatedTranslations = translationsByPackageBlock(cells, options.removedCells ?? [])
  const hasLocatedTranslations = locatedTranslations.size > 0
  // AQU-1068. BOTH lookups are built BEFORE the package walk, which is the
  // point of the guard in buildLegacyGroups: an added cell that consumed a
  // positional slot would shift every mapping after it and write translations
  // into the wrong paragraphs of the client's document.
  const removedKeys = removedPackageBlockKeys(options.removedCells ?? [], cells)
  const insertions = insertionsAfterPackageBlock(cells, isUserAddedLine)
  // AQU-2552 (review r6): the paragraphs that lost a line, hidden or deleted.
  const lostLineKeys = removedPackageBlockKeys([
    ...(options.removedCells ?? []),
    ...cells.filter((cell) => cell.hidden === true).map((cell) => ({ metadata: cell.metadata ?? null })),
  ])

  // AQU-2539: the two things the target language changes in what is written.
  const targetLanguage = options.targetLanguage?.trim() || null
  const writeText = isFrenchLanguage(targetLanguage) ? frenchSpacing : (text: string) => text
  const translatedLook = (rPr: string) => (targetLanguage ? rPrWithLanguage(rPr, targetLanguage) : rPr)

  // AQU-2539: every w:p, nested ones included, numbered as the importer
  // numbers them. Rendering walks this list; the regex it replaces could not
  // see a paragraph inside another one.
  const spans = scanDocxParagraphs(xml)
  const blockKeyOf = (index: number) => packageBlockKey(DOCUMENT_PART, `w:p[${index}]`)

  // Which translation drives each paragraph, by paragraph index. A cell with
  // no translation (untranslated, or cleared by a validated-only export) gives
  // its paragraph none: the paragraph keeps its own words.
  const translations = new Map<number, ParagraphTranslation>()
  if (hasLocatedTranslations) {
    for (const span of spans) {
      const located = locatedTranslations.get(blockKeyOf(span.index))
      if (located && located.parts.length > 0) {
        translations.set(span.index, {
          parts: located.parts,
          label: located.label,
          source: located.source,
          ...(lostLineKeys.has(blockKeyOf(span.index)) ? { lostLines: true as const } : {}),
        })
      }
    }
  } else {
    // Positional fallback for cells imported before locators: the k-th group
    // is the k-th paragraph with text, by the rule that importer used.
    let slot = 0
    for (const span of spans) {
      if (!hasAnyText(xml, span)) continue
      const group = groups[slot++]
      if (group === undefined) continue
      const data = groupToData.get(group)!
      if (data.parts.length > 0) translations.set(span.index, { parts: data.parts, label: group, source: data.source })
    }
  }

  let injected = 0
  let untouched = 0
  let removed = 0
  let inserted = 0
  const lostLooks: { segment: string; words: string[] }[] = []
  const fidelity: DocxExportFidelity = {
    keptLooks: 0, keptFields: 0, keptLinks: 0, emptiedFields: 0, droppedLinks: 0, notesWritten: 0, notesLeft: 0,
    staleTextBoxHolders: 0, textBoxCellsAdopted: 0, textBoxCellsNotSplit: 0, unplacedFootnoteMarkers: 0,
  }

  /** Index into `spans` of the first paragraph starting at or after `offset`. */
  const firstSpanAtOrAfter = (offset: number): number => {
    let lo = 0
    let hi = spans.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (spans[mid].start < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** The source bytes [from, to), with every paragraph inside rendered.
   *  `self` is the paragraph whose own bytes these are, if any: it is the
   *  container being rendered, not a paragraph nested in the range. */
  function renderRange(from: number, to: number, self?: DocxParagraphSpan): string {
    let out = ""
    let cursor = from
    let k = firstSpanAtOrAfter(from)
    if (self && spans[k] === self) k++
    while (k < spans.length && spans[k].start < to) {
      const span = spans[k]
      out += xml!.slice(cursor, span.start)
      out += renderParagraph(span)
      cursor = span.end
      while (k < spans.length && spans[k].start < cursor) k++
    }
    return out + xml!.slice(cursor, to)
  }

  function renderParagraph(span: DocxParagraphSpan): string {
    // A copy (the old-reader Fallback of a text box) mirrors the paragraph it
    // copies: same translation, same removal, same additions. Unpaired copies
    // are left exactly as they are.
    const driver = span.isCopy ? span.copyOf : span.index
    const verbatim = () => renderRange(span.start, span.end, span)
    if (driver === 0) return verbatim()
    const key = blockKeyOf(driver)
    const anchorXml = xml!.slice(span.start, span.end)
    const nonEmpty = hasAnyText(xml!, span)

    // AQU-1068: this paragraph's cell was REMOVED. Emit nothing at all — the
    // paragraph leaves the document. Indices come from the INPUT scan, so
    // every later locator still resolves; nothing shifts. The last paragraph
    // of its container (a table cell, a text box, a note) is emptied instead,
    // pPr kept: Word needs a cell or a box to keep a paragraph.
    if (nonEmpty && removedKeys.has(key)) {
      if (!span.isCopy) removed++
      if (lastInContainer.get(span.container) !== span.index) return ""
      const open = anchorXml.slice(0, anchorXml.indexOf(">") + 1)
      const inner = anchorXml.slice(open.length, anchorXml.lastIndexOf("</w:p>"))
      return `${open}${extractPPr(inner)}</w:p>`
    }

    // A copy is rendered like its twin but not counted a second time.
    const counted = !span.isCopy
    const translation = translations.get(driver)
    const rebuilt = translation ? rebuildParagraph(span, translation, counted) : null
    let out: string
    if (rebuilt === null) {
      out = verbatim()
      if (nonEmpty && counted) untouched++
    } else {
      out = rebuilt
      if (counted) injected++
    }
    return out + renderInsertions(key, anchorXml, counted)
  }

  /**
   * AQU-1068: write out any cells added UNDER this paragraph, as new
   * paragraphs of their own in the anchor's style.
   */
  function renderInsertions(blockKey: string, anchorXml: string, counted = true): string {
    const texts = insertions.get(blockKey)
    if (!texts || texts.length === 0) return ""
    const selfClosing = !anchorXml.includes("</w:p>")
    const openTag = selfClosing ? "<w:p>" : anchorXml.slice(0, anchorXml.indexOf(">") + 1)
    const inner = selfClosing ? "" : anchorXml.slice(openTag.length, anchorXml.lastIndexOf("</w:p>"))
    const pPrXml = extractPPr(inner)
    const baseRprXml = extractFirstRunRpr(pPrXml ? inner.slice(inner.indexOf(pPrXml) + pPrXml.length) : inner)
    let out = ""
    for (const text of texts) {
      const spans = plainSpans(writeText(text))
      out += `${openTag}${pPrXml}${runsForSpans(spans, baseRprXml, translatedLook)}</w:p>`
      if (counted) inserted++
    }
    return out
  }

  const part: PartContext = { xml, walkContext, renderRange, writeText, translatedLook }

  // The last paragraph directly in each container (see renderParagraph).
  const lastInContainer = new Map<number, number>()
  for (const s of spans) if (s.container !== 0) lastInContainer.set(s.container, s.index)

  // Paragraphs nested directly in each paragraph (its text boxes' lines).
  const nestedIn = new Map<number, DocxParagraphSpan[]>()
  for (const s of spans) {
    if (s.parent === 0 || s.isCopy || s.selfClosing) continue
    const list = nestedIn.get(s.parent) ?? []
    list.push(s)
    nestedIn.set(s.parent, list)
  }

  const squash = (text: string) => text.replace(/\s+/g, "")
  /** A paragraph's line, as the importer reads it today. */
  const lineTextOf = (s: DocxParagraphSpan): string => {
    if (s.selfClosing) return ""
    const p = parseXmlLite(xml!.slice(s.start, s.end)).children.find(isElement)
    return p ? docxLine(walkDocxParagraph(p, walkContext)).text : ""
  }
  /** The result's warnings: each asks for a re-import of the file. */
  const reimportWarnings: { segment: string; detail: string }[] = []

  const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1
  /** The paragraphs inside a paragraph's text boxes (at any depth), with words. */
  const boxLinesIn = (holder: DocxParagraphSpan) =>
    spans
      .filter((s) => s.start > holder.start && s.end <= holder.end && !s.isCopy && !s.selfClosing)
      .map((s) => {
        const text = lineTextOf(s)
        return { span: s, text, words: squash(text) }
      })
      .filter((box) => box.words.length > 0)

  // AQU-2539, OLD IMPORTS. Before text boxes were read separately, a text box's
  // words were read three times: into the paragraph holding the box, into the
  // box's own paragraph, and into its stored copy (the Fallback an old reader
  // shows), each line with a cell of its own. A text-box paragraph on an old
  // import takes the first translation found among the lines that held its
  // words: its own, its stored copy's, then the holder's if it is the same
  // words repeated. A fresh import gives copies and word-less holders no
  // cells, so none of this can fire on one.
  //
  // Its stored copy's: a text box and its copy share one translation.
  for (const copy of spans) {
    if (!copy.isCopy || copy.copyOf === 0 || translations.has(copy.copyOf)) continue
    const own = translations.get(copy.index)
    if (!own) continue
    translations.set(copy.copyOf, own)
    fidelity.textBoxCellsAdopted++
  }

  // The holder's. A holder's cell that held its boxes' words cannot be written
  // into the body (they would land there), so it is left alone. When the
  // holder has no words of its own and the cell's source is ONE untranslated
  // box paragraph's words repeated (whitespace ignored), the cell is that box
  // paragraph's: its translation, the same repetition taken out, is written
  // there (its copy mirrors it). Otherwise every box paragraph the cell held
  // that is left without a translation is named in a warning, once, instead of
  // staying English silently; so is a holder with words of its own.
  const staleHolders = new Set<number>()
  const named = new Set<number>()
  const notSplit = "this text box was imported before text boxes were read separately and its words cannot be told apart in the old translation; re-import the file to translate it"
  const nameBoxes = (boxes: { span: DocxParagraphSpan; text: string }[], detail = notSplit) => {
    const fresh = boxes.filter((box) => !named.has(box.span.index))
    if (fresh.length === 0) return
    for (const box of fresh) named.add(box.span.index)
    fidelity.textBoxCellsNotSplit += fresh.length
    reimportWarnings.push({ segment: firstWords(fresh[0].text), detail })
  }
  for (const holder of spans) {
    const translation = translations.get(holder.index)
    if (holder.isCopy || !translation || !nestedIn.has(holder.index)) continue
    const source = squash(translation.source)
    const own = squash(lineTextOf(holder))
    // A cell made by today's importer holds exactly the paragraph's own line;
    // an old one held the words of the boxes inside too.
    if (!source || source === own) continue
    // With no words of its own, everything its cell held was its boxes' (even
    // words hidden there now, which today's lines leave out).
    const held = boxLinesIn(holder).filter((box) => !own || occurrences(source, box.words) > occurrences(own, box.words))
    if (held.length === 0) continue
    const untranslated = held.filter((box) => !translations.has(box.span.index))
    if (own) {
      staleHolders.add(holder.index)
      fidelity.staleTextBoxHolders++
      reimportWarnings.push({
        segment: firstWords(lineTextOf(holder)),
        detail: "imported before text boxes were read separately; re-import the file to translate this paragraph",
      })
      for (const box of untranslated) nameBoxes([box])
      continue
    }
    const fits = untranslated.filter((box) =>
      source.length % box.words.length === 0 && box.words.repeat(source.length / box.words.length) === source)
    const one = fits.length === 1 ? fits[0] : null
    // A holder cell only partly translated gives its box no whole translation.
    const whole = !translation.parts.some((part) => part.untranslated)
    const derived = one && whole ? withoutRepetition(translation.parts.map((part) => part.plain).join(" "), source.length / one.words.length) : null
    if (one && derived) {
      translations.set(one.span.index, { parts: [{ plain: derived, html: "" }], label: translation.label, source: one.text })
      fidelity.textBoxCellsAdopted++
      continue
    }
    if (fits.length > 1) {
      nameBoxes(fits, `${fits.length} text boxes with these words were imported before text boxes were read separately, and the old translation cannot say which one it belongs to; re-import the file to translate them`)
    }
    for (const box of untranslated) nameBoxes([box])
  }
  const noteTranslations = new Map<string, string>()

  function rebuildParagraph(span: DocxParagraphSpan, translation: ParagraphTranslation, counted: boolean): string | null {
    // A holder whose old cell held its text boxes' words keeps its own words
    // (see above), and so does its copy.
    if (staleHolders.has(span.isCopy ? span.copyOf : span.index)) return null
    const rebuilt = rebuildParagraphIn(part, span, (line) => {
      const stretches = locateLines(translation.parts, line)
      return {
        spans: restoreLineSeparators(translationSpans(translation.parts, line, stretches), line, translation.source),
        layout: { stretches, lost: translation.lostLines ? lostStretches(stretches, line) : [] },
      }
    })
    if (rebuilt === null) return null
    if (!counted) return rebuilt.xml
    // Fidelity report: words with a look of their own that the translation
    // changed (the export dialog lists the paragraph).
    if (rebuilt.stats.lostLooks.length > 0) {
      lostLooks.push({ segment: firstWords(lineTextOf(span)), words: [...new Set(rebuilt.stats.lostLooks.map(firstWords))] })
    }
    addFidelity(fidelity, rebuilt.stats)
    for (const note of rebuilt.stats.footnotes) noteTranslations.set(note.id, note.marker)
    return rebuilt.xml
  }

  // Rendering starts at the top of the document; the walk is driven by the
  // INPUT scan, so neither a removal nor an insertion can shift a locator.
  const rebuilt = renderRange(0, xml.length)

  // AQU-2539: a footnote whose translated note text differs from its source
  // gets that text written into word/footnotes.xml, in its own paragraph, by
  // the same rules as the body (its number and everything not text kept).
  const rebuiltFootnotes = footnotesXml
    ? rebuildFootnotes(footnotesXml, noteTranslations, walkContext, writeText, translatedLook, fidelity, lostLooks)
    : null

  // AQU-2383: the surgical scan spliced nothing, so `word/document.xml` is
  // the one the client uploaded and no other part was ever written. Hand back
  // the original package rather than a re-zip of it: `generateAsync` rewrites
  // member order, compression and local headers, so an untouched export would
  // otherwise come back as a different file than the upload — which is the
  // whole complaint behind the untouched-export rule. The counts are already
  // final here, so the result still reports the walk honestly.
  if (rebuilt === xml && rebuiltFootnotes === null) {
    return {
      blob: new Blob([rawDocxBytes], { type: DOCX_MIME }),
      injected,
      untouched,
      removed,
      inserted,
      warnings: reimportWarnings,
      lostLooks,
      fidelity,
    }
  }

  // AQU-2539: never hand back a document Word has to repair. The partner's
  // export was not well-formed XML (the nested-paragraph regex); whatever the
  // cause, a part that does not parse fails the export instead of reaching
  // the user.
  try {
    assertWellFormedXml(rebuilt)
  } catch (err) {
    throw new Error(
      `Word export stopped: the rebuilt word/document.xml is not well-formed (${(err as Error).message}). ` +
        "No file was produced, so no damaged document reaches the client.",
      { cause: err },
    )
  }

  // Write modified XML back — only word/document.xml (and, when a note was
  // translated, word/footnotes.xml) changes; all other parts untouched.
  zip.file(DOCUMENT_PART, rebuilt, { createFolders: false })
  if (rebuiltFootnotes !== null) {
    try {
      assertWellFormedXml(rebuiltFootnotes)
    } catch (err) {
      throw new Error(
        `Word export stopped: the rebuilt word/footnotes.xml is not well-formed (${(err as Error).message}). ` +
          "No file was produced, so no damaged document reaches the client.",
        { cause: err },
      )
    }
    zip.file(FOOTNOTES_PART, rebuiltFootnotes, { createFolders: false })
  }

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
  return { blob, injected, untouched, removed, inserted, warnings: reimportWarnings, lostLooks, fidelity }
}

/** A paragraph's first words, to name it in a warning. */
function firstWords(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  return words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : words.join(" ")
}

/**
 * `text` with a repetition taken out: when its characters other than
 * whitespace are one stretch repeated `times` times, that stretch as it is
 * written the first time; otherwise null (not a clean repetition).
 */
function withoutRepetition(text: string, times: number): string | null {
  const trimmed = text.trim()
  const marks: number[] = []
  for (let k = 0; k < trimmed.length; k++) if (!/\s/.test(trimmed[k])) marks.push(k)
  if (times < 1 || marks.length === 0 || marks.length % times !== 0) return null
  const unit = marks.length / times
  for (let k = unit; k < marks.length; k++) if (trimmed[marks[k]] !== trimmed[marks[k - unit]]) return null
  return trimmed.slice(0, marks[unit - 1] + 1).trim()
}

/** One XML part being rendered: what a paragraph rebuild needs from it. */
interface PartContext {
  xml: string
  walkContext: DocxWalkContext
  /** The part's bytes [from, to) with nested paragraphs rendered. */
  renderRange(from: number, to: number, self?: DocxParagraphSpan): string
  writeText(text: string): string
  translatedLook(rPr: string): string
}

interface RebuiltParagraph {
  xml: string
  stats: RebuildResult
}

/** A stretch [start, end) of a paragraph's line text. */
interface LineStretch {
  start: number
  end: number
}

/** AQU-2552 (review r6): where the lines of a paragraph cut into several sit
 *  in its line text. */
interface LineLayout {
  /** Per line (part), its own stretch, or null where its source is not found. */
  stretches: readonly (LineStretch | null)[]
  /** What hidden or deleted lines held: each stretch between two remaining
   *  lines (or the paragraph's edge) that holds more than whitespace. */
  lost: readonly LineStretch[]
}

/** What a paragraph's translation is written from (see rebuildParagraphIn). */
interface ParagraphText {
  spans: Span[]
  layout?: LineLayout
}

function addFidelity(total: DocxExportFidelity, stats: RebuildResult): void {
  total.keptLooks += stats.keptLooks
  total.keptFields += stats.keptFields
  total.keptLinks += stats.keptLinks
  total.emptiedFields += stats.emptiedFields
  total.droppedLinks += stats.droppedLinks
  total.unplacedFootnoteMarkers += stats.unplacedMarkers
}

/**
 * Rebuild one translated paragraph of a part, or return null to leave it as it
 * is: a paragraph with no visible words makes no line on import, so it
 * receives no translation on export either (an old import may still hold a
 * cell for one, from when a text box's words were read into the paragraph
 * around it). `leadingSpace` keeps the source line's leading whitespace in
 * front of the translation (a footnote's space after its number).
 */
function rebuildParagraphIn(
  part: PartContext,
  span: DocxParagraphSpan,
  textFor: (lineText: string) => ParagraphText,
  leadingSpace = false,
): RebuiltParagraph | null {
  if (span.selfClosing) return null
  const { xml } = part
  const doc = parseXmlLite(xml.slice(span.start, span.end), { offsets: true })
  const p = doc.children.find(isElement)
  if (!p) return null
  const at = (offset: number | undefined) => span.start + (offset ?? 0)
  const items = walkDocxParagraph(p, part.walkContext)
  const line = docxLine(items)
  if (!line.hasWords) return null
  const { spans, layout } = textFor(line.text)
  if (spans.length === 0) return null

  const flat = flattenPieces(items)
  const inLine = linePieceFlags(flat)
  const lineSet = new Set<DocxPiece>(flat.filter((_, k) => inLine[k]))
  const placed = layout ? placeInLines(flat, inLine, layout) : null

  // The innermost wrapper holding all of the line: the paragraph itself, or
  // a hyperlink / content control / … that holds every word.
  let target: { el: XmlElement; items: DocxPiece[] } = { el: p, items }
  for (;;) {
    const holders = target.items.filter((item) => holdsLine(item, lineSet))
    const only = holders.length === 1 ? holders[0] : null
    if (only === null || only.kind !== "container") break
    target = { el: only.el, items: only.items }
  }

  const runRprXml = (run: XmlElement): string => {
    const rPr = run.children.find((c) => isElement(c) && c.tagName === "w:rPr") as XmlElement | undefined
    return rPr ? xml.slice(at(rPr.start), at(rPr.end)) : ""
  }
  const base = baseRunLook(line.chunks, runRprXml)

  const lead = leadingSpace ? /^\s*/.exec(line.text)![0] : ""
  const all = lead ? [{ text: lead, marks: new Set<Mark>() }, ...spans] : spans
  const text = all.map((s) => s.text).join("")
  const marks: ReadonlySet<Mark>[] = []
  const lineOf: (number | undefined)[] = []
  for (const s of all) {
    for (let i = 0; i < s.text.length; i++) {
      marks.push(s.marks)
      lineOf.push(s.line)
    }
  }
  // A line with no translation is written as its source (AQU-2539): each of
  // its characters in its own look and as the source has it, with neither the
  // translation's language nor its language's spacing rules.
  const lineLooks: (string | null)[] = []
  for (const chunk of line.chunks) {
    const look = chunk.piece.kind === "text" ? runRprXml(chunk.piece.run) : null
    for (let i = 0; i < chunk.text.length; i++) lineLooks.push(look)
  }
  const sourceLooks: (string | undefined)[] = []
  for (const s of all) {
    for (let i = 0; i < s.text.length; i++) {
      sourceLooks.push(s.fromLine === undefined ? undefined : s.fromLine >= 0 ? (lineLooks[s.fromLine + i] ?? base ?? "") : (base ?? ""))
    }
  }
  const translatedText = part.writeText(text)
  // (writeText keeps the length, so index i is the same character in both.)
  const writtenText = sourceLooks.some((look) => look !== undefined)
    ? text.split("").map((ch, i) => (sourceLooks[i] !== undefined ? ch : translatedText[i])).join("")
    : translatedText
  const io: RebuildIo = {
    elementXml: (el) => part.renderRange(at(el.start), at(el.end), span),
    openTag: (el) => xml.slice(at(el.start), at(el.openEnd)),
    closeTag: (el) => xml.slice(at(el.closeStart), at(el.end)),
    rPrXml: runRprXml,
  }
  const stats = rebuildParagraphInner({
    items: target.items,
    lineSet,
    text,
    writtenText,
    marks,
    sourceLooks,
    ...(placed ? { lineOf, footnoteLines: placed.footnoteLines, lost: placed.lost, lostChar: placed.lostChar } : {}),
    translatedLook: part.translatedLook,
    baseRpr: base ?? "",
    io,
  })
  const before = part.renderRange(span.start, at(target.el.openEnd), span)
  const after = part.renderRange(at(target.el.closeStart), span.end, span)
  return { xml: before + stats.xml + after, stats }
}

/**
 * word/footnotes.xml with translated notes written in, or null when no note
 * changed. A note's translation is the text of its USFM marker in the body's
 * translation. It is written only into a note with exactly one paragraph of
 * words (a note of several paragraphs was imported as one line and cannot be
 * split back) and only when it differs from the source note.
 */
function rebuildFootnotes(
  footnotesXml: string,
  noteTranslations: ReadonlyMap<string, string>,
  walkContext: DocxWalkContext,
  writeText: (text: string) => string,
  translatedLook: (rPr: string) => string,
  fidelity: DocxExportFidelity,
  lostLooks: { segment: string; words: string[] }[],
): string | null {
  if (noteTranslations.size === 0) return null
  const doc = parseXmlLite(footnotesXml, { offsets: true })
  const spans = scanDocxParagraphs(footnotesXml)
  const part: PartContext = {
    xml: footnotesXml,
    walkContext,
    renderRange: (from, to) => footnotesXml.slice(from, to),
    writeText,
    translatedLook,
  }
  const edits: { start: number; end: number; xml: string }[] = []
  for (const note of elementsByTagName(doc, "w:footnote")) {
    const id = getAttribute(note, "w:id")
    const marker = id === null ? undefined : noteTranslations.get(id)
    if (marker === undefined) continue
    const translated = extractUsfmFootnotes(marker)[0]?.text.replace(/\\(?:bd|it|ul)\*?\s?/g, "").trim() ?? ""
    // Compared in the marker's own form (whitespace collapsed, backslashes
    // dropped), so a note nobody translated is never rewritten.
    const sourceNote = walkContext.footnotes.get(id!) ?? ""
    const sourceAsMarker = extractUsfmFootnotes(createUsfmFootnoteMarker({ caller: "+", text: sourceNote }))[0]?.text ?? ""
    if (!translated || translated === sourceAsMarker.replace(/\\(?:bd|it|ul)\*?\s?/g, "").trim()) continue
    const inside = spans.filter((s) => s.start >= note.start! && s.end <= note.end!)
    const withWords = inside.filter((s) => {
      const p = parseXmlLite(footnotesXml.slice(s.start, s.end)).children.find(isElement)
      return p !== undefined && docxLine(walkDocxParagraph(p, walkContext)).hasWords
    })
    if (withWords.length !== 1) {
      fidelity.notesLeft++
      continue
    }
    const rebuilt = rebuildParagraphIn(part, withWords[0], () => ({ spans: [{ text: translated, marks: new Set() }] }), true)
    if (rebuilt === null) continue
    edits.push({ start: withWords[0].start, end: withWords[0].end, xml: rebuilt.xml })
    fidelity.notesWritten++
    if (rebuilt.stats.lostLooks.length > 0) lostLooks.push({ segment: firstWords(sourceNote), words: [...new Set(rebuilt.stats.lostLooks.map(firstWords))] })
  }
  if (edits.length === 0) return null
  let out = ""
  let cursor = 0
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    out += footnotesXml.slice(cursor, edit.start) + edit.xml
    cursor = edit.end
  }
  return out + footnotesXml.slice(cursor)
}

/** Does this piece hold any of the line (directly, or inside a wrapper)? */
function holdsLine(item: DocxPiece, lineSet: ReadonlySet<DocxPiece>): boolean {
  if (item.kind === "container") return item.items.some((inner) => holdsLine(inner, lineSet))
  return lineSet.has(item)
}

const NO_MARKS: ReadonlySet<Mark> = new Set()

/** Plain text as one markless span: a translation without HTML is TEXT, never
 *  markup (a literal "<b>" in it must come back as those four characters). */
function plainSpans(text: string): Span[] {
  return text ? [{ text, marks: new Set(NO_MARKS) }] : []
}

/** A paragraph's translation as marked spans, segments joined by one space.
 *  Each segment uses its own HTML when the editor wrote one, else its plain text. */
/**
 * A paragraph's translation as marked spans. Each segment uses its own HTML
 * when the editor wrote one, else its plain text. Segments are joined by the
 * whitespace the SOURCE had between them (AQU-2539): a line break or tab where
 * the paragraph was cut into lines stays a line break or tab — every
 * translation is trimmed, so the break is not in it. AQU-2552 (review r6): so
 * is any other gap, as it is (two spaces stay two, none after a dash the
 * importer cut at stays none); one space only where a line is not found in
 * the paragraph, so its gap is not known.
 */
function translationSpans(
  parts: readonly { plain: string; html: string; source?: string; untranslated?: true }[],
  lineText = "",
  stretches: readonly (LineStretch | null)[] = locateLines(parts, lineText),
): Span[] {
  const out: Span[] = []
  let previous: LineStretch | null = null
  parts.forEach((part, line) => {
    // Where this segment's source sits in the paragraph's line, if it does.
    const at = stretches[line]
    // AQU-2552 (review r6): where hidden or deleted lines sat between the
    // two, the gap is the one before them; theirs went with them.
    const gap = at && previous ? /^\s*/.exec(lineText.slice(previous.end, at.start))![0] : null
    previous = at
    const spans = part.html ? htmlToSpans(part.html) : []
    // A line with no translation is its source, as it sits in the line.
    const segment = part.untranslated
      ? plainSpans(at ? lineText.slice(at.start, at.end) : part.plain).map((span) => ({ ...span, fromLine: at ? at.start : -1 }))
      : spans.length > 0 ? spans : plainSpans(part.plain)
    if (segment.length === 0) return
    if (out.length > 0 && gap !== "") out.push({ text: gap ?? " ", marks: new Set(NO_MARKS) })
    // AQU-2552 (review r6): each line's text knows its line (its footnotes).
    out.push(...segment.map((span) => ({ ...span, line })))
  })
  return out
}

/**
 * AQU-2552 (review r6): where each line's source sits in the paragraph's line
 * text, in order, or null where it is not found there. The importer keeps a
 * line's words as the paragraph has them, but joins sentences it keeps on one
 * line with one space, so there a run of whitespace matches any run.
 */
function locateLines(
  parts: readonly { source?: string }[],
  lineText: string,
): (LineStretch | null)[] {
  let cursor = 0
  return parts.map((part) => {
    const source = (part.source ?? "").trim()
    const found = source ? findInLine(lineText, source, cursor) : null
    if (found) cursor = found.end
    return found
  })
}

function findInLine(lineText: string, source: string, from: number): LineStretch | null {
  const exact = lineText.indexOf(source, from)
  if (exact !== -1) return { start: exact, end: exact + source.length }
  const loose = new RegExp(source.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g")
  loose.lastIndex = from
  const m = loose.exec(lineText)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/**
 * AQU-2552 (review r6): what hidden or deleted lines held of a paragraph: each
 * stretch between two remaining lines, or between a line and the paragraph's
 * edge, that holds more than whitespace. Only when every remaining line is
 * found in the paragraph; otherwise whose words are whose cannot be told, and
 * nothing is left out.
 */
function lostStretches(stretches: readonly (LineStretch | null)[], lineText: string): LineStretch[] {
  const found = stretches.filter((s): s is LineStretch => s !== null)
  if (found.length !== stretches.length) return []
  const out: LineStretch[] = []
  let previous = 0
  for (const s of [...found, { start: lineText.length, end: lineText.length }]) {
    if (/\S/.test(lineText.slice(previous, s.start))) out.push({ start: previous, end: s.start })
    previous = s.end
  }
  return out
}

/**
 * AQU-2552 (review r6): the line whose stretch of the paragraph holds each
 * footnote reference (where its marker sits in the line text), and what a
 * hidden or deleted line held, which is left out: the line's text and
 * footnote references wholly inside its stretch, and the runs (pictures,
 * symbols, a field's parts) that sit inside it. Bookmarks, comment marks and
 * the like pair with something elsewhere and stay; so does anything before
 * the paragraph's first word or after its last, as on import.
 */
function placeInLines(
  flat: readonly DocxPiece[],
  inLine: readonly boolean[],
  layout: LineLayout,
): { footnoteLines: Map<DocxPiece, number>; lost: Set<DocxPiece>; lostChar: (piece: DocxPiece, i: number) => boolean } {
  const footnoteLines = new Map<DocxPiece, number>()
  const lost = new Set<DocxPiece>()
  const textStart = new Map<DocxPiece, number>()
  const inLost = (at: number) => layout.lost.some((s) => s.start <= at && at < s.end)
  let end = 0
  flat.forEach((piece, k) => {
    const start = end
    const isLine = inLine[k] && (piece.kind === "text" || piece.kind === "footnote")
    if (isLine) end += piece.kind === "text" ? piece.text.length : piece.kind === "footnote" ? (piece.marker ?? "").length : 0
    if (isLine && piece.kind === "text") textStart.set(piece, start)
    if (isLine && piece.kind === "footnote") {
      const line = layout.stretches.findIndex((s) => s !== null && s.start <= start && start < s.end)
      if (line !== -1) footnoteLines.set(piece, line)
    }
    const gone = isLine
      ? layout.lost.some((s) => s.start <= start && end <= s.end)
      : givenUpWithLine(piece) && layout.lost.some((s) => s.start < start && start < s.end)
    if (gone) lost.add(piece)
  })
  // A run that holds both a lost line's words and another line's.
  const lostChar = (piece: DocxPiece, i: number) => {
    const start = textStart.get(piece)
    return start !== undefined && inLost(start + i)
  }
  return { footnoteLines, lost, lostChar }
}

/** A piece that leaves with the lost line it sits in (see placeInLines). */
function givenUpWithLine(piece: DocxPiece): boolean {
  if (piece.kind === "keepInRun" || piece.kind === "footnote" || piece.kind === "text") return true
  if (piece.kind !== "keep" || piece.el.tagName !== "w:r") return false
  return !piece.el.children.some((child) => isElement(child) && child.tagName === "w:commentReference")
}

const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u

/**
 * Unchanged text keeps what it had — including the tab or line break that
 * separated it from the rest of its line (AQU-2539). A project imported before
 * tabs and breaks were read has translations without them ("KJVVersion King
 * James" for "KJV⇥King James Version"). When the translation carries none of
 * its own, the line's first stretch (up to its first tab or break) found
 * unchanged at the start of the translation gets that separator after it, and
 * the line's last stretch found unchanged at the end gets the separator before
 * it. Where the translation runs straight on from that text, it is split there
 * only if the cell's own source ran on there too (the old import glued them),
 * so a translation that merely begins with the same letters is never split.
 * The stretch counts by the same guard as a look stretch (not a lone letter).
 */
function restoreLineSeparators(spans: Span[], lineText: string, source: string): Span[] {
  if (!/[\t\n]/.test(lineText)) return spans
  const text = spans.map((s) => s.text).join("")
  if (/[\t\n]/.test(text)) return spans
  const pieces = lineText.split(/([\t\n]+)/)
  if (pieces.length < 3) return spans
  const isWord = (ch: string | undefined) => ch !== undefined && WORD_CHAR_RE.test(ch)
  const src = source.trim()
  const edits: { at: number; remove: number; insert: string }[] = []

  const first = pieces[0].trim()
  const lead = text.length - text.trimStart().length
  if (anchorCounts(first) && text.startsWith(first, lead)) {
    const end = lead + first.length
    const spaces = /^[ \u00A0]*/.exec(text.slice(end))![0].length
    const runsOn = isWord(first[first.length - 1]) && isWord(text[end])
    const sourceRanOn = src.startsWith(first) && /\S/.test(src[first.length] ?? "")
    if (end < text.length && (spaces > 0 || !runsOn || sourceRanOn)) {
      edits.push({ at: end, remove: spaces, insert: pieces[1] })
    }
  }
  const last = pieces[pieces.length - 1].trim()
  const trail = text.length - text.trimEnd().length
  const lastStart = text.length - trail - last.length
  const sameSeparator = pieces.length === 3 && edits.length > 0
  if (anchorCounts(last) && !sameSeparator && lastStart > 0 && text.startsWith(last, lastStart)) {
    const spaces = /[ \u00A0]*$/.exec(text.slice(0, lastStart))![0].length
    const runsOn = isWord(text[lastStart - 1]) && isWord(last[0])
    const sourceRanOn = src.endsWith(last) && /\S/.test(src[src.length - last.length - 1] ?? "")
    if (lastStart - spaces > 0 && (spaces > 0 || !runsOn || sourceRanOn)) {
      edits.push({ at: lastStart - spaces, remove: spaces, insert: pieces[pieces.length - 2] })
    }
  }
  let out = spans
  for (const edit of edits.sort((a, b) => b.at - a.at)) out = spliceSpans(out, edit.at, edit.remove, edit.insert)
  return out
}

/** Spans with `remove` characters at `at` replaced by unmarked `insert`. */
function spliceSpans(spans: readonly Span[], at: number, remove: number, insert: string): Span[] {
  const out: Span[] = []
  let offset = 0
  let inserted = false
  for (const span of spans) {
    const start = offset
    const end = offset + span.text.length
    offset = end
    const keepBefore = span.text.slice(0, Math.max(0, Math.min(span.text.length, at - start)))
    const keepAfter = span.text.slice(Math.max(0, Math.min(span.text.length, at + remove - start)))
    if (end <= at || start >= at + remove) {
      if (!inserted && start >= at) {
        out.push({ text: insert, marks: new Set(NO_MARKS) })
        inserted = true
      }
      out.push(span)
      continue
    }
    if (keepBefore) out.push({ ...span, text: keepBefore })
    if (!inserted) {
      out.push({ text: insert, marks: new Set(NO_MARKS) })
      inserted = true
    }
    if (keepAfter && end > at + remove) {
      const shift = span.text.length - keepAfter.length
      out.push({ ...span, text: keepAfter, ...(span.fromLine !== undefined && span.fromLine >= 0 ? { fromLine: span.fromLine + shift } : {}) })
    }
  }
  if (!inserted) out.push({ text: insert, marks: new Set(NO_MARKS) })
  return out
}

/**
 * The run look the translation is written in (AQU-2539): the `w:rPr` that
 * covers the most LETTERS of the paragraph's text that is not bold, italic,
 * underlined, struck through, right-to-left, superscript or subscript — so a
 * paragraph that opens with a bold term is not translated all in bold, a
 * mostly-Hebrew line does not put its French in the Hebrew right-to-left look,
 * and a cell of sigla does not put its text in superscript. Vowel points and
 * accents are not letters. When every letter carries one of those marks (a
 * bold heading), it is the look covering most of the letters; characters are
 * counted only when the line has no letters at all. Ties go to the look met
 * first. Null when that look is no rPr at all.
 */
function baseRunLook(
  chunks: ReturnType<typeof docxLine>["chunks"],
  runRprXml: (run: XmlElement) => string,
): string | null {
  const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length
  const characters = (text: string) => text.replace(/\s+/g, "").length
  const tally = (plainOnly: boolean, measure: (text: string) => number): string | null => {
    const counts = new Map<string, number>()
    for (const chunk of chunks) {
      if (chunk.piece.kind !== "text" || chunk.piece.source !== "t") continue
      const look = runRprXml(chunk.piece.run)
      if (plainOnly && (chunk.marks.size > 0 || isRightToLeft(look) || isRaisedOrLowered(look))) continue
      const count = measure(chunk.text)
      if (count === 0) continue
      counts.set(look, (counts.get(look) ?? 0) + count)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [look, n] of counts) {
      if (n > bestCount) {
        best = look
        bestCount = n
      }
    }
    return best
  }
  // Letters decide; characters only when the line has no letters at all.
  const look = tally(true, letters) ?? tally(false, letters) ?? tally(true, characters) ?? tally(false, characters)
  return look ? look : null
}

/** Is this run look superscript or subscript? */
function isRaisedOrLowered(rPrXml: string): boolean {
  const el = rPrXml ? directRprChild(rPrXml, "vertAlign") : null
  return el !== null && /\sw:val="(superscript|subscript)"/.test(el)
}

/** Is this run look right-to-left (`w:rtl` on)? */
function isRightToLeft(rPrXml: string): boolean {
  const rtl = rPrXml ? directRprChild(rPrXml, "rtl") : null
  if (rtl === null) return false
  const val = /\sw:val="([^"]*)"/.exec(rtl)?.[1]
  return val === undefined || !/^(0|false|off)$/i.test(val)
}

function runsForSpans(
  spans: readonly Span[],
  baseRprXml: string | null,
  look: (rPr: string) => string = (rPr) => rPr,
): string {
  // Neighbouring stretches with the same look are one run.
  let out = ""
  let pendingText = ""
  let pendingRpr: string | null = null
  for (const span of spans) {
    const rPr = look(rPrWithMarks(baseRprXml, span.marks))
    if (pendingRpr !== null && rPr !== pendingRpr) {
      out += textRunXml(pendingText, pendingRpr)
      pendingText = ""
    }
    pendingRpr = rPr
    pendingText += span.text
  }
  if (pendingRpr !== null) out += textRunXml(pendingText, pendingRpr)
  return out
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
 * `innerAfterPPr`. Used for the look of a paragraph ADDED in the app, which
 * copies the paragraph it follows.
 */
function extractFirstRunRpr(innerAfterPPr: string): string | null {
  const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g
  let runMatch: RegExpExecArray | null
  while ((runMatch = runRegex.exec(innerAfterPPr)) !== null) {
    const runContent = runMatch[0]
    const tMatch = runContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/)
    if (!tMatch || !tMatch[1].trim()) continue
    const rPrMatch = runContent.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/)
    if (rPrMatch) return rPrMatch[0]
    const rPrSelf = runContent.match(/<w:rPr\b[^>]*\/>/)
    if (rPrSelf) return rPrSelf[0]
    return null
  }
  return null
}
