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
import { htmlToSpans, rPrWithLanguage, rPrWithMarks, textRunXml, type Mark, type Span } from "./docx-runs"
import { frenchSpacing, isFrenchLanguage } from "./french-spacing"
import { markKey, rebuildParagraphInner, type RebuildIo, type RebuildResult } from "./docx-rebuild"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import {
  packageBlockKey,
  translationsByPackageBlock,
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
  /** Per-paragraph inline-style warnings: translated paragraphs whose source
   *  had MIXED run formatting keep only the dominant run's styling as the base —
   *  surfaced so users know the output was simplified (additive field). */
  warnings: { segment: string; detail: string }[]
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
  /** Paragraphs holding a text box whose cell (from before AQU-2539) also
   *  holds the box's words: left as they are, with a warning to re-import. */
  staleTextBoxHolders: number
}

/** One paragraph's translation: its segments in order, with their sources. */
interface ParagraphTranslation {
  parts: { plain: string; html: string; source?: string }[]
  label: string
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
  groupToData: Map<string, { html: string; plain: string; parts: { plain: string; html: string; source: string }[] }>
} {
  const groups: string[] = []
  const groupToData = new Map<string, { html: string; plain: string; parts: { plain: string; html: string; source: string }[] }>()
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
      groupToData.set(legacyGroup, { html: "", plain: "", parts: [] })
    }
    const data = groupToData.get(legacyGroup)!
    const plain = cell.translated?.trim() ?? ""
    const html = cell.translatedHtml?.trim() ?? ""
    if (plain) data.plain = data.plain ? `${data.plain} ${plain}` : plain
    if (html) data.html = data.html ? `${data.html} ${html}` : html
    if (plain || html) data.parts.push({ plain, html, source: cell.original ?? "" })
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
  re.lastIndex = span.start
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null && m.index < span.end) {
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
  const locatedTranslations = translationsByPackageBlock(cells)
  const hasLocatedTranslations = locatedTranslations.size > 0
  // AQU-1068. BOTH lookups are built BEFORE the package walk, which is the
  // point of the guard in buildLegacyGroups: an added cell that consumed a
  // positional slot would shift every mapping after it and write translations
  // into the wrong paragraphs of the client's document.
  const removedKeys = removedPackageBlockKeys(options.removedCells ?? [])
  const insertions = insertionsAfterPackageBlock(cells, isUserAddedLine)

  // AQU-2539: the two things the target language changes in what is written.
  const targetLanguage = options.targetLanguage?.trim() || null
  const writeText = isFrenchLanguage(targetLanguage) ? frenchSpacing : (text: string) => text
  const translatedLook = (rPr: string) => (targetLanguage ? rPrWithLanguage(rPr, targetLanguage) : rPr)

  // AQU-2539: every w:p, nested ones included, numbered as the importer
  // numbers them. Rendering walks this list; the regex it replaces could not
  // see a paragraph inside another one.
  const spans = scanDocxParagraphs(xml)
  const blockKeyOf = (index: number) => packageBlockKey(DOCUMENT_PART, `w:p[${index}]`)

  // Which translation drives each paragraph, by paragraph index.
  const translations = new Map<number, ParagraphTranslation>()
  if (hasLocatedTranslations) {
    for (const span of spans) {
      const located = locatedTranslations.get(blockKeyOf(span.index))
      if (located) translations.set(span.index, { parts: located.parts, label: located.label })
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
      translations.set(span.index, { parts: data.parts, label: group })
    }
  }

  let injected = 0
  let untouched = 0
  let removed = 0
  let inserted = 0
  const warnings: { segment: string; detail: string }[] = []
  const fidelity: DocxExportFidelity = {
    keptLooks: 0, keptFields: 0, keptLinks: 0, emptiedFields: 0, droppedLinks: 0, notesWritten: 0, notesLeft: 0,
    staleTextBoxHolders: 0,
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
    // every later locator still resolves; nothing shifts.
    if (nonEmpty && removedKeys.has(key)) {
      removed++
      return ""
    }

    const translation = translations.get(driver)
    const rebuilt = translation ? rebuildParagraph(span, translation) : null
    let out: string
    if (rebuilt === null) {
      out = verbatim()
      if (nonEmpty) untouched++
    } else {
      out = rebuilt
      injected++
    }
    return out + renderInsertions(key, anchorXml)
  }

  /**
   * AQU-1068: write out any cells added UNDER this paragraph, as new
   * paragraphs of their own in the anchor's style.
   */
  function renderInsertions(blockKey: string, anchorXml: string): string {
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
      inserted++
    }
    return out
  }

  const part: PartContext = { xml, walkContext, renderRange, writeText, translatedLook }

  /** Does this translation's source hold the words of a text box inside the
   *  paragraph (see rebuildParagraph)? */
  function sourceSwallowedTextBox(span: DocxParagraphSpan, translation: ParagraphTranslation): boolean {
    const nested = spans.filter((s) => s.parent === span.index && !s.isCopy && !s.selfClosing)
    if (nested.length === 0) return false
    const squash = (text: string) => text.replace(/\s+/g, "")
    const lineOf = (s: DocxParagraphSpan) => {
      const p = parseXmlLite(xml!.slice(s.start, s.end)).children.find(isElement)
      return p ? squash(docxLine(walkDocxParagraph(p, walkContext)).text) : ""
    }
    const source = squash(translation.parts.map((p) => p.source ?? "").join(""))
    const own = lineOf(span)
    // A paragraph with no words of its own is never written anyway; a cell made
    // by today's importer holds exactly the paragraph's own line.
    if (!source || !own || source === own) return false
    return nested.some((inner) => {
      const words = lineOf(inner)
      return words.length > 0 && source.includes(words)
    })
  }
  const noteTranslations = new Map<string, string>()

  function rebuildParagraph(span: DocxParagraphSpan, translation: ParagraphTranslation): string | null {
    // A project imported before AQU-2539 read a text box's words into the
    // paragraph holding the box. Its translation holds them too and cannot be
    // split back, so writing it would put the box's words into the body. Such
    // a cell is recognised by its source NOT being the paragraph's own line
    // while containing the box's words; the paragraph keeps its own words and
    // the box is translated by its own cells.
    if (sourceSwallowedTextBox(span, translation)) {
      fidelity.staleTextBoxHolders++
      warnings.push({
        segment: translation.label,
        detail: "imported before text boxes were read separately; re-import the file to translate this paragraph",
      })
      return null
    }
    const rebuilt = rebuildParagraphIn(part, span, (line) => translationSpans(translation.parts, line))
    if (rebuilt === null) return null
    // Fidelity report: the source paragraph carried more than one run look
    // and some of it may come back in the base look (the export dialog says so).
    if (rebuilt.mixedLooks) {
      warnings.push({
        segment: translation.label,
        detail: "paragraph had mixed inline formatting; translation takes the look of most of its plain text",
      })
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
    ? rebuildFootnotes(footnotesXml, noteTranslations, walkContext, writeText, translatedLook, fidelity)
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
      warnings,
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
  return { blob, injected, untouched, removed, inserted, warnings, fidelity }
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
  mixedLooks: boolean
}

function addFidelity(total: DocxExportFidelity, stats: RebuildResult): void {
  total.keptLooks += stats.keptLooks
  total.keptFields += stats.keptFields
  total.keptLinks += stats.keptLinks
  total.emptiedFields += stats.emptiedFields
  total.droppedLinks += stats.droppedLinks
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
  spansFor: (lineText: string) => Span[],
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
  const spans = spansFor(line.text)
  if (spans.length === 0) return null

  const flat = flattenPieces(items)
  const inLine = linePieceFlags(flat)
  const lineSet = new Set<DocxPiece>(flat.filter((_, k) => inLine[k]))

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
  const looks = new Set(
    line.chunks
      .filter((c) => c.piece.kind === "text" && c.piece.source === "t" && c.text.trim())
      .map((c) => runRprXml((c.piece as Extract<DocxPiece, { kind: "text" }>).run)),
  )

  const lead = leadingSpace ? /^\s*/.exec(line.text)![0] : ""
  const all = lead ? [{ text: lead, marks: new Set<Mark>() }, ...spans] : spans
  const text = all.map((s) => s.text).join("")
  const marks: ReadonlySet<Mark>[] = []
  for (const s of all) for (let i = 0; i < s.text.length; i++) marks.push(s.marks)
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
    writtenText: part.writeText(text),
    marks,
    translatedLook: part.translatedLook,
    baseRpr: base ?? "",
    markLooks: markLooksOf(line.chunks, runRprXml),
    io,
  })
  const before = part.renderRange(span.start, at(target.el.openEnd), span)
  const after = part.renderRange(at(target.el.closeStart), span.end, span)
  return { xml: before + stats.xml + after, stats, mixedLooks: looks.size > 1 }
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
    if (!translated || translated === walkContext.footnotes.get(id!)) continue
    const inside = spans.filter((s) => s.start >= note.start! && s.end <= note.end!)
    const withWords = inside.filter((s) => {
      const p = parseXmlLite(footnotesXml.slice(s.start, s.end)).children.find(isElement)
      return p !== undefined && docxLine(walkDocxParagraph(p, walkContext)).hasWords
    })
    if (withWords.length !== 1) {
      fidelity.notesLeft++
      continue
    }
    const rebuilt = rebuildParagraphIn(part, withWords[0], () => [{ text: translated, marks: new Set() }], true)
    if (rebuilt === null) continue
    edits.push({ start: withWords[0].start, end: withWords[0].end, xml: rebuilt.xml })
    fidelity.notesWritten++
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
 * the paragraph was cut into lines stays a line break or tab, anything else is
 * one space — every translation is trimmed, so the break is not in it.
 */
function translationSpans(
  parts: readonly { plain: string; html: string; source?: string }[],
  lineText = "",
): Span[] {
  const out: Span[] = []
  let cursor = 0
  let previousEnd = -1
  for (const part of parts) {
    // Where this segment's source sits in the paragraph's line, if it does.
    const source = (part.source ?? "").trim()
    const at = source ? lineText.indexOf(source, cursor) : -1
    const gap = at >= 0 && previousEnd >= 0 ? lineText.slice(previousEnd, at) : ""
    if (at >= 0) {
      previousEnd = at + source.length
      cursor = previousEnd
    } else {
      previousEnd = -1
    }
    const spans = part.html ? htmlToSpans(part.html) : []
    const segment = spans.length > 0 ? spans : plainSpans(part.plain)
    if (segment.length === 0) continue
    if (out.length > 0) out.push({ text: gap.replace(/[^\t\n]/g, "") || " ", marks: new Set(NO_MARKS) })
    out.push(...segment)
  }
  return out
}

/**
 * The run look the translation is written in (AQU-2539): the `w:rPr` that
 * covers the most characters of the paragraph's text WITHOUT bold, italic,
 * underline or strikethrough, so a paragraph that opens with a bold term is
 * not translated all in bold. When every character carries one of those marks
 * (a heading set in bold), it is the look covering most of all the text. Ties
 * go to the look met first. Null when that look is no rPr at all.
 */
function baseRunLook(
  chunks: ReturnType<typeof docxLine>["chunks"],
  runRprXml: (run: XmlElement) => string,
): string | null {
  const tally = (unmarkedOnly: boolean): string | null => {
    const counts = new Map<string, number>()
    for (const chunk of chunks) {
      if (chunk.piece.kind !== "text" || chunk.piece.source !== "t") continue
      if (unmarkedOnly && chunk.marks.size > 0) continue
      const chars = chunk.text.replace(/\s+/g, "").length
      if (chars === 0) continue
      const look = runRprXml(chunk.piece.run)
      counts.set(look, (counts.get(look) ?? 0) + chars)
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
  const look = tally(true) ?? tally(false)
  return look ? look : null
}

/**
 * For each set of marks the source's text carries, the run look it carries
 * them in — when that is ONE look. A translated stretch with the same marks
 * (the translator's bold over "Terme :") then takes the source's own look for
 * them, font and size included, instead of base-plus-a-bold-toggle.
 */
function markLooksOf(
  chunks: ReturnType<typeof docxLine>["chunks"],
  runRprXml: (run: XmlElement) => string,
): Map<string, string> {
  const byKey = new Map<string, Set<string>>()
  for (const chunk of chunks) {
    if (chunk.piece.kind !== "text" || chunk.piece.source !== "t" || !chunk.text.trim()) continue
    const key = markKey(chunk.marks as ReadonlySet<Mark>)
    if (key === "") continue
    const set = byKey.get(key) ?? new Set<string>()
    set.add(runRprXml(chunk.piece.run))
    byKey.set(key, set)
  }
  const out = new Map<string, string>()
  for (const [key, set] of byKey) if (set.size === 1) out.set(key, [...set][0])
  return out
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
