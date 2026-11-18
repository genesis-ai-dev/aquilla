import { v4 as uuid } from "uuid"
// Types come from core-types (not types.ts): types.ts pulls `@/`-aliased SPA
// modules, and this parser is now imported by the sync-worker too (AQU-1237).
import type { CellUnit, TranslatableString } from "./core-types"
import { splitIntoSegments } from "./text-splitter"
import { assertSafeArchiveInputSize, assertSafeZipLiteArchive } from "./zip-safety"
import { readZipLite, readZipLiteEntryText, type ZipLiteArchive } from "./zip-lite"
import {
  elementsByTagName,
  getAttribute,
  parseXmlLite,
  textContent,
  type XmlElement,
} from "./xml-lite"
import {
  directChild,
  docxLine,
  hiddenRunTest,
  readDocxStyleSheet,
  scanDocxParagraphs,
  walkDocxParagraph,
  type DocxLineChunk,
  type DocxMark,
  type DocxWalkContext,
} from "./docx-structure"

// AQU-662: DOCX footnotes (word/footnotes.xml) are followed from their
// w:footnoteReference anchors in word/document.xml and inlined into the cell
// text as USFM \f...\f* markers. Reusing the USFM marker representation means
// the whole existing footnote pipeline — inline decoration, hover, editing,
// export round-trip, and completion footnote-awareness — works for DOCX with no
// new display code. See src/lib/footnotes/extract.ts.
//
// AQU-1237: this parser used to depend on the Window-only `DOMParser` and on
// JSZip, which is what kept DOCX out of the Agent API's server-side import path
// (sync-worker/src/external/import-parse.ts). It now reads its archive through
// `zip-lite` and its XML through `xml-lite` — both platform-only — so the
// browser, the parse Web Worker, and the Cloudflare Worker run this SAME
// function. Format parity between an in-app import and an agent import is
// therefore structural, not a thing two implementations have to agree on.

/** Matches a full USFM footnote span so the segment splitter can be prevented
 *  from breaking one across cells. Mirrors USFM_FOOTNOTE_RE in footnotes/extract.ts. */
const FOOTNOTE_SPAN_RE = /\\f\s+[^\s\\]+[\s\S]*?\\f\*/g

// Private-use sentinels wrapping a numeric index. They never appear in real
// document text and carry no whitespace/punctuation, so a masked footnote span
// stays glued to its anchor word, is never itself split apart by the segment
// splitter, and cannot collide with real digits already in the paragraph.
const MASK_OPEN = ""
const MASK_CLOSE = ""
const MASK_RE = /(\d+)/g

// Stand-ins for a tab and a line break while the segment splitter runs
// (AQU-2539): not whitespace, so the splitter neither cuts at them nor turns
// them into spaces.
const TAB_MASK = ""
const BREAK_MASK = ""
const TAB_MASK_RE = //g
const BREAK_MASK_RE = //g

const DOCUMENT_PART = "word/document.xml"
const FOOTNOTES_PART = "word/footnotes.xml"
const STYLES_PART = "word/styles.xml"

/**
 * Ceiling on the inflated `word/document.xml` this parser will try to build a
 * tree for (AQU-1499).
 *
 * `zip-safety` bounds the ARCHIVE (95 MB in, 128 MB per entry), but nothing
 * bounded what this parser then does with the part it reads, and the full
 * element tree costs roughly 19× the XML: a 41.7 MB `document.xml` measures at
 * ~785 MB of heap. For a document Word saved with one `<w:r><w:rPr>…` per
 * character — which is what a real 68k-word Arabic partner book looked like,
 * 39.5 MB of XML from 882 KB on disk — an unbounded parse is a frozen tab on a
 * low-memory device, and death inside the 128 MB Cloudflare Worker that runs
 * this same function for the Agent API's server-side import
 * (sync-worker/src/external/import-parse.ts). A 128 MB entry would be ~2.4 GB
 * of tree.
 *
 * So the limit is deliberately set ABOVE the real-world bloat this issue was
 * filed for — that file must still import — and only refuses the shapes no
 * device survives, with a message that says what is wrong instead of hanging.
 * Lowering the tree's cost (a streaming, paragraph-at-a-time parse) is how this
 * number comes down; it is a change to `xml-lite`'s contract, not to this cap.
 */
const MAX_DOCUMENT_XML_CHARS = 64 * 1024 * 1024 // 64 M chars

/** The XML parts a DOCX import reads, already inflated and decoded. Splitting
 *  this out lets a caller that already holds the archive (or the raw parts)
 *  reuse the exact cell-building logic without a second unzip. */
export interface DocxParts {
  documentXml: string
  footnotesXml?: string
  /** word/styles.xml: where text hidden through a style is declared (AQU-2539). */
  stylesXml?: string
}

/** Per-import parse options. `cellUnit: "paragraph"` (AQU-1720) emits one cell
 *  per `w:p` with no sentence split and no length cap — the unit a dubbing
 *  project generates one voice clip for. Default stays `"sentence"`. */
export interface DocxParseOptions {
  cellUnit?: CellUnit
}

export async function extractDocxStrings(
  buffer: ArrayBuffer,
  options?: DocxParseOptions,
): Promise<TranslatableString[]> {
  assertSafeArchiveInputSize(buffer.byteLength, "DOCX file")
  let archive: ZipLiteArchive
  try {
    archive = readZipLite(buffer)
  } catch (err) {
    throw new Error(`DOCX file appears to be corrupt (could not unzip): ${(err as Error).message}`, {
      cause: err,
    })
  }
  assertSafeZipLiteArchive(archive, "DOCX file")

  const documentXml = await readZipLiteEntryText(archive, DOCUMENT_PART)
  if (documentXml === null) throw new Error("DOCX file does not contain word/document.xml")
  const footnotesXml = await readZipLiteEntryText(archive, FOOTNOTES_PART)
  const stylesXml = await readZipLiteEntryText(archive, STYLES_PART)

  return docxPartsToStrings({
    documentXml,
    ...(footnotesXml !== null ? { footnotesXml } : {}),
    ...(stylesXml !== null ? { stylesXml } : {}),
  }, options)
}

/**
 * Refuse a `word/document.xml` too large to build a tree for, naming the size
 * and the fix, rather than letting the parse take the tab (or the Worker) down
 * with it (AQU-1499). See MAX_DOCUMENT_XML_CHARS.
 */
function assertParseableDocumentXml(documentXml: string): void {
  if (documentXml.length <= MAX_DOCUMENT_XML_CHARS) return
  const mb = (chars: number) => (chars / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")
  throw new Error(
    `DOCX file is too complex to parse: word/document.xml is ${mb(documentXml.length)} MB, ` +
      `over the ${mb(MAX_DOCUMENT_XML_CHARS)} MB limit. Re-saving the file from Word ` +
      `("Save As" a new .docx) usually shrinks it.`,
  )
}

/** Turn the DOCX XML parts into translatable cells. Pure (no zip, no DOM). */
export function docxPartsToStrings(
  parts: DocxParts,
  options?: DocxParseOptions,
): TranslatableString[] {
  const cellUnit = options?.cellUnit ?? "sentence"
  assertParseableDocumentXml(parts.documentXml)
  const doc = parseXmlLite(parts.documentXml)
  const footnotes = parts.footnotesXml === undefined ? new Map<string, string>() : loadFootnotes(parts.footnotesXml)

  const results: TranslatableString[] = []
  const paragraphs = elementsByTagName(doc, "w:p")
  // AQU-2539: the exporter finds paragraphs in the raw XML with this same scan,
  // so `w:p[N]` means the same paragraph on both sides — nested ones included.
  const spans = scanDocxParagraphs(parts.documentXml)
  if (spans.length !== paragraphs.length) {
    throw new Error(
      `DOCX paragraph scan disagrees with the XML tree (${spans.length} vs ${paragraphs.length})`,
    )
  }
  // AQU-2539: the app imports what Word shows and prints; hidden runs are not
  // part of any line (see hiddenRunTest in docx-structure.ts).
  const walkContext: DocxWalkContext = {
    footnotes,
    isHiddenRun: hiddenRunTest(
      readDocxStyleSheet(parts.stylesXml === undefined ? undefined : parseXmlLite(parts.stylesXml)),
    ),
  }

  for (let i = 0; i < paragraphs.length; i++) {
    // A paragraph in a later branch of mc:AlternateContent is a copy of one in
    // the first branch (the same text box stored for old readers): no line.
    if (spans[i].isCopy) continue
    const p = paragraphs[i]
    const line = docxLine(walkDocxParagraph(p, walkContext))
    if (!line.hasWords) continue
    const plain = line.text
    const hasFootnote = line.chunks.some((chunk) => chunk.piece.kind === "footnote")

    const style = getParaStyle(p)
    const context = style || "Paragraph"
    const type = style?.startsWith("Heading") || style === "Title"
      ? ("heading" as const)
      : ("text" as const)
    const segments = splitFootnoteAware(plain, cellUnit)
    const sourceLocation = {
      file: DOCUMENT_PART,
      blockPath: `w:p[${i + 1}]`,
    }

    // AQU-2539: every line of the paragraph carries its own inline marks, so a
    // paragraph split into several lines keeps them too. A footnote is carried
    // as an inline USFM marker in the plain text and rendered by the plain-text
    // footnote decoration; the source's HTML display has no footnote
    // representation, so a footnoted paragraph still has no HTML.
    const htmls = hasFootnote ? segments.map(() => undefined) : segmentHtml(plain, line.chunks, segments)

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      results.push({
        id: uuid(),
        original: seg.text,
        originalHtml: htmls[i],
        translated: "",
        context,
        group: seg.group,
        type,
        sourceLocation,
        // D2: first sub-cell of each paragraph block carries paragraphStart; continuations do not.
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    }
  }

  return results
}

/**
 * Split a paragraph into segments without ever breaking a USFM footnote span.
 * Footnote spans are masked to a break-character-free placeholder (so the
 * splitter treats it as part of a word), then restored per-segment.
 */
function splitFootnoteAware(
  plain: string,
  cellUnit: CellUnit = "sentence",
): { text: string; group: string }[] {
  // Nothing is ever cut in paragraph mode, so the masking round-trip that
  // protects footnote spans from the splitter has no work to do (AQU-1720).
  if (cellUnit === "paragraph") return splitIntoSegments(plain, undefined, "paragraph")
  if (!plain.includes("\\f") && !plain.includes("\t") && !plain.includes("\n")) {
    return splitIntoSegments(plain)
  }

  const spans: string[] = []
  // AQU-2539: a tab or line break is part of the line. The splitter treats
  // them as whitespace it may cut at and rejoin with a plain space, which would
  // silently turn them into spaces; masked, they stay inside their segment.
  const masked = plain
    .replace(FOOTNOTE_SPAN_RE, (span) => {
      spans.push(span)
      return `${MASK_OPEN}${spans.length - 1}${MASK_CLOSE}`
    })
    .replace(/\t/g, TAB_MASK)
    .replace(/\n/g, BREAK_MASK)

  const restore = (text: string) =>
    text
      .replace(MASK_RE, (_m, idx) => spans[Number(idx)] ?? "")
      .replace(TAB_MASK_RE, "\t")
      .replace(BREAK_MASK_RE, "\n")

  return splitIntoSegments(masked).map((s) => ({ ...s, text: restore(s.text) }))
}

/**
 * Read word/footnotes.xml (if present) into an id → footnote-text map. The
 * special separator / continuationSeparator footnotes (ids -1, 0) carry no
 * user content and are skipped.
 */
export function loadFootnotes(footnotesXml: string): Map<string, string> {
  const map = new Map<string, string>()
  const doc = parseXmlLite(footnotesXml)
  const notes = elementsByTagName(doc, "w:footnote")

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const id = getAttribute(note, "w:id")
    if (id === null) continue
    const noteType = getAttribute(note, "w:type")
    if (noteType === "separator" || noteType === "continuationSeparator") continue

    const textEls = elementsByTagName(note, "w:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) text += textContent(textEls[j])
    text = text.trim()
    if (text) map.set(id, text)
  }

  return map
}

/**
 * Each segment's inline-mark HTML, or undefined when it carries no mark. The
 * splitter may rejoin a cut with one space where the paragraph had other
 * whitespace, so each segment is aligned to the paragraph's characters, any
 * whitespace run matching any whitespace run; a character takes the marks of
 * the run it came from. Text is HTML-escaped.
 */
function segmentHtml(
  plain: string,
  chunks: readonly DocxLineChunk[],
  segments: readonly { text: string }[],
): (string | undefined)[] {
  const marks: ReadonlySet<DocxMark>[] = []
  for (const chunk of chunks) for (let k = 0; k < chunk.text.length; k++) marks.push(chunk.marks)
  if (!marks.some((m) => m.size > 0)) return segments.map(() => undefined)
  const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)
  let cursor = 0
  return segments.map(({ text }) => {
    while (cursor < plain.length && isSpace(plain[cursor]) && !isSpace(text[0])) cursor++
    // at[k]: the paragraph character that segment character k came from.
    const at: number[] = []
    let k = 0
    while (k < text.length) {
      if (isSpace(text[k]) && isSpace(plain[cursor])) {
        // A whitespace run in the segment matches the paragraph's whole run.
        const from = cursor
        while (cursor < plain.length && isSpace(plain[cursor])) cursor++
        while (k < text.length && isSpace(text[k])) {
          at.push(from)
          k++
        }
        continue
      }
      at.push(Math.min(cursor, plain.length - 1))
      cursor++
      k++
    }
    let html = ""
    let any = false
    let start = 0
    const keyAt = (k: number) => markKeyOf(marks[at[k]])
    for (let k = 1; k <= text.length; k++) {
      if (k < text.length && keyAt(k) === keyAt(start)) continue
      const set = marks[at[start]] ?? NO_DOCX_MARKS
      let piece = escapeHtml(text.slice(start, k))
      if (set.has("b")) { piece = `<b>${piece}</b>`; any = true }
      if (set.has("i")) { piece = `<i>${piece}</i>`; any = true }
      if (set.has("u")) { piece = `<u>${piece}</u>`; any = true }
      if (set.has("s")) { piece = `<s>${piece}</s>`; any = true }
      html += piece
      start = k
    }
    return any ? html : undefined
  })
}

const NO_DOCX_MARKS: ReadonlySet<DocxMark> = new Set()
const markKeyOf = (set: ReadonlySet<DocxMark> | undefined) => (set ? [...set].sort().join("+") : "")
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function getParaStyle(p: XmlElement): string | null {
  // The paragraph's OWN pPr: a descendant search would read a text box's style.
  const pPr = directChild(p, "w:pPr")
  if (!pPr) return null
  const pStyle = directChild(pPr, "w:pStyle")
  if (!pStyle) return null
  const val = getAttribute(pStyle, "w:val") || ""

  const headingMatch = val.match(/^Heading(\d+)$/i)
  if (headingMatch) return `Heading ${headingMatch[1]}`
  if (val === "Title") return "Title"
  return val
}
