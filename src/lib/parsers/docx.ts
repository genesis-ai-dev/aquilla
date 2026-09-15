import { v4 as uuid } from "uuid"
// Types come from core-types (not types.ts): types.ts pulls `@/`-aliased SPA
// modules, and this parser is now imported by the sync-worker too (AQU-1237).
import type { TranslatableString } from "./core-types"
import { splitIntoSegments } from "./text-splitter"
import { assertSafeArchiveInputSize, assertSafeZipLiteArchive } from "./zip-safety"
import { readZipLite, readZipLiteEntryText, type ZipLiteArchive } from "./zip-lite"
import {
  elementsByTagName,
  firstElementByTagName,
  getAttribute,
  parseXmlLite,
  textContent,
  type XmlElement,
} from "./xml-lite"
import { createUsfmFootnoteMarker } from "../footnotes/insert"

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

const DOCUMENT_PART = "word/document.xml"
const FOOTNOTES_PART = "word/footnotes.xml"

/** The XML parts a DOCX import reads, already inflated and decoded. Splitting
 *  this out lets a caller that already holds the archive (or the raw parts)
 *  reuse the exact cell-building logic without a second unzip. */
export interface DocxParts {
  documentXml: string
  footnotesXml?: string
}

export async function extractDocxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
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

  return docxPartsToStrings({
    documentXml,
    ...(footnotesXml !== null ? { footnotesXml } : {}),
  })
}

/** Turn the DOCX XML parts into translatable cells. Pure (no zip, no DOM). */
export function docxPartsToStrings(parts: DocxParts): TranslatableString[] {
  const doc = parseXmlLite(parts.documentXml)
  const footnotes = parts.footnotesXml === undefined ? new Map<string, string>() : loadFootnotes(parts.footnotesXml)

  const results: TranslatableString[] = []
  const paragraphs = elementsByTagName(doc, "w:p")

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const { plain, html, hasFormatting, hasFootnote } = extractRuns(p, footnotes)
    if (!plain.trim()) continue

    const style = getParaStyle(p)
    const context = style || "Paragraph"
    const type = style?.startsWith("Heading") || style === "Title"
      ? ("heading" as const)
      : ("text" as const)
    const segments = splitFootnoteAware(plain)
    const sourceLocation = {
      file: DOCUMENT_PART,
      blockPath: `w:p[${i + 1}]`,
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      results.push({
        id: uuid(),
        original: seg.text,
        // A footnote is carried as an inline USFM marker in the plain text and
        // rendered by the plain-text footnote decoration; the run-formatting
        // HTML path has no footnote representation, so disable it for footnoted
        // paragraphs rather than drop the note from display.
        originalHtml: segments.length === 1 && hasFormatting && !hasFootnote ? html : undefined,
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
function splitFootnoteAware(plain: string): { text: string; group: string }[] {
  if (!plain.includes("\\f")) return splitIntoSegments(plain)

  const spans: string[] = []
  const masked = plain.replace(FOOTNOTE_SPAN_RE, (span) => {
    spans.push(span)
    return `${MASK_OPEN}${spans.length - 1}${MASK_CLOSE}`
  })

  const restore = (text: string) =>
    text.replace(MASK_RE, (_m, idx) => spans[Number(idx)] ?? "")

  return splitIntoSegments(masked).map((s) => ({ ...s, text: restore(s.text) }))
}

/**
 * Read word/footnotes.xml (if present) into an id → footnote-text map. The
 * special separator / continuationSeparator footnotes (ids -1, 0) carry no
 * user content and are skipped.
 */
function loadFootnotes(footnotesXml: string): Map<string, string> {
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

function extractRuns(
  p: XmlElement,
  footnotes: Map<string, string>,
): { plain: string; html: string; hasFormatting: boolean; hasFootnote: boolean } {
  const runs = elementsByTagName(p, "w:r")
  let plain = ""
  let html = ""
  let hasFormatting = false
  let hasFootnote = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]

    // A footnote-reference run carries no w:t; it anchors a note from
    // word/footnotes.xml. Inline the note as a USFM marker at this position.
    const ref = firstElementByTagName(run, "w:footnoteReference")
    if (ref) {
      const id = getAttribute(ref, "w:id")
      const noteText = id !== null ? footnotes.get(id) : undefined
      if (noteText) {
        const marker = createUsfmFootnoteMarker({ caller: "+", text: noteText })
        plain += marker
        html += marker
        hasFootnote = true
      }
      continue
    }

    const textEls = elementsByTagName(run, "w:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) {
      text += textContent(textEls[j])
    }

    if (!text) continue

    const rPr = firstElementByTagName(run, "w:rPr")
    const bold = rPr !== undefined && firstElementByTagName(rPr, "w:b") !== undefined
    const italic = rPr !== undefined && firstElementByTagName(rPr, "w:i") !== undefined
    const underline = rPr !== undefined && firstElementByTagName(rPr, "w:u") !== undefined
    const strike = rPr !== undefined && firstElementByTagName(rPr, "w:strike") !== undefined

    plain += text

    let htmlText = text
    if (bold) { htmlText = `<b>${htmlText}</b>`; hasFormatting = true }
    if (italic) { htmlText = `<i>${htmlText}</i>`; hasFormatting = true }
    if (underline) { htmlText = `<u>${htmlText}</u>`; hasFormatting = true }
    if (strike) { htmlText = `<s>${htmlText}</s>`; hasFormatting = true }
    html += htmlText
  }

  return { plain, html, hasFormatting, hasFootnote }
}

function getParaStyle(p: XmlElement): string | null {
  const pPr = firstElementByTagName(p, "w:pPr")
  if (!pPr) return null
  const pStyle = firstElementByTagName(pPr, "w:pStyle")
  if (!pStyle) return null
  const val = getAttribute(pStyle, "w:val") || ""

  const headingMatch = val.match(/^Heading(\d+)$/i)
  if (headingMatch) return `Heading ${headingMatch[1]}`
  if (val === "Title") return "Title"
  return val
}
