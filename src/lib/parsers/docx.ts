import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"
import { assertSafeArchiveInputSize, assertSafeZipArchive } from "./zip-safety"
import { createUsfmFootnoteMarker } from "@/lib/footnotes/insert"

// AQU-662: DOCX footnotes (word/footnotes.xml) are followed from their
// w:footnoteReference anchors in word/document.xml and inlined into the cell
// text as USFM \f...\f* markers. Reusing the USFM marker representation means
// the whole existing footnote pipeline — inline decoration, hover, editing,
// export round-trip, and completion footnote-awareness — works for DOCX with no
// new display code. See src/lib/footnotes/extract.ts.

/** Matches a full USFM footnote span so the segment splitter can be prevented
 *  from breaking one across cells. Mirrors USFM_FOOTNOTE_RE in footnotes/extract.ts. */
const FOOTNOTE_SPAN_RE = /\\f\s+[^\s\\]+[\s\S]*?\\f\*/g

// Private-use sentinels wrapping a numeric index. They never appear in real
// document text and carry no whitespace/punctuation, so a masked footnote span
// stays glued to its anchor word, is never itself split apart by the segment
// splitter, and cannot collide with real digits already in the paragraph.
const MASK_OPEN = "\uE000"
const MASK_CLOSE = "\uE001"
const MASK_RE = /\uE000(\d+)\uE001/g

export async function extractDocxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  assertSafeArchiveInputSize(buffer.byteLength, "DOCX file")
  const zip = await JSZip.loadAsync(buffer)
  assertSafeZipArchive(zip, "DOCX file")
  const documentEntry = zip.file("word/document.xml")
  if (!documentEntry) throw new Error("DOCX file does not contain word/document.xml")
  const xmlStr = await documentEntry.async("string")
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml")

  const footnotes = await loadFootnotes(zip)

  const results: TranslatableString[] = []
  const paragraphs = doc.getElementsByTagName("w:p")

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
      file: "word/document.xml",
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
async function loadFootnotes(zip: JSZip): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const entry = zip.file("word/footnotes.xml")
  if (!entry) return map

  const xmlStr = await entry.async("string")
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml")
  const notes = doc.getElementsByTagName("w:footnote")

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const id = note.getAttribute("w:id")
    if (id === null) continue
    const noteType = note.getAttribute("w:type")
    if (noteType === "separator" || noteType === "continuationSeparator") continue

    const textEls = note.getElementsByTagName("w:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) text += textEls[j].textContent || ""
    text = text.trim()
    if (text) map.set(id, text)
  }

  return map
}

function extractRuns(
  p: Element,
  footnotes: Map<string, string>,
): { plain: string; html: string; hasFormatting: boolean; hasFootnote: boolean } {
  const runs = p.getElementsByTagName("w:r")
  let plain = ""
  let html = ""
  let hasFormatting = false
  let hasFootnote = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]

    // A footnote-reference run carries no w:t; it anchors a note from
    // word/footnotes.xml. Inline the note as a USFM marker at this position.
    const ref = run.getElementsByTagName("w:footnoteReference")[0]
    if (ref) {
      const id = ref.getAttribute("w:id")
      const noteText = id !== null ? footnotes.get(id) : undefined
      if (noteText) {
        const marker = createUsfmFootnoteMarker({ caller: "+", text: noteText })
        plain += marker
        html += marker
        hasFootnote = true
      }
      continue
    }

    const textEls = run.getElementsByTagName("w:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) {
      text += textEls[j].textContent || ""
    }

    if (!text) continue

    const rPr = run.getElementsByTagName("w:rPr")[0]
    const bold = rPr?.getElementsByTagName("w:b").length > 0
    const italic = rPr?.getElementsByTagName("w:i").length > 0
    const underline = rPr?.getElementsByTagName("w:u").length > 0
    const strike = rPr?.getElementsByTagName("w:strike").length > 0

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

function getParaStyle(p: Element): string | null {
  const pPr = p.getElementsByTagName("w:pPr")[0]
  if (!pPr) return null
  const pStyle = pPr.getElementsByTagName("w:pStyle")[0]
  if (!pStyle) return null
  const val = pStyle.getAttribute("w:val") || ""

  const headingMatch = val.match(/^Heading(\d+)$/i)
  if (headingMatch) return `Heading ${headingMatch[1]}`
  if (val === "Title") return "Title"
  return val
}
