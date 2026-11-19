// AQU-2551 (question 54): a plain Word document written from a file's lines,
// for a file that has no uploaded .docx to write the translation into — a PDF
// source, and any other source without one. The round-trip Word export
// (exporters/docx.ts) still serves a file imported from Word.
//
// What it keeps:
//   * headings stay headings (Title, Heading 1–6, from the line's type and
//     "Heading N" context), so the document re-imports with the same headings;
//   * paragraphs are paragraphs: a paragraph's lines are joined with one
//     space, as the text and Markdown exports join them. A line starts a new
//     paragraph where the import marked one (paragraphStart); a file that
//     carries no paragraph starts joins only lines that share a group, as
//     those exports do;
//   * footnotes become real Word footnotes, from the inline `\f … \f*` notes
//     the Word, PDF and USFM imports carry (any note kind becomes a footnote);
//   * a paragraph whose text reads right-to-left is set right-to-left;
//   * bold and italic marks (`\bd …\bd*`, `\it …\it*`) are bold and
//     italic runs (AQU-2680);
//   * a tagged PDF's list items are Word list items, bulleted or numbered at
//     their depth, Word doing the numbering (AQU-2680);
//   * a paragraph the import found wholly bold or italic (a PDF's subtitle, a
//     quotation) is bold or italic (AQU-2680);
//   * the page is the size the import recorded (a PDF's first page), else A4
//     (AQU-2680).
// An untranslated line falls back to its source text, as the other exports do.
//
// Valid against the ECMA-376 WordprocessingML schema (document, styles,
// footnotes, numbering, settings); see docx-from-lines.test.ts.

import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { detectStrongTextDirection } from "@/lib/text-direction"
import { cellLines, type InlineRun } from "./html-blocks"

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** One paragraph of the document: its style, and its runs in order. */
export interface LinesParagraph {
  /** "Title", "Heading1"…"Heading6", or null for body text. */
  style: string | null
  /** The paragraph's lines; a break inside a line (a poetry line) is a line too. */
  lines: InlineRun[][]
  /** AQU-2680: a list item (a tagged PDF's), bulleted or numbered, at a depth
   *  0–8, with the label it was printed with ("a)", "1.1.3."), if known; an
   *  item of kind "none" had no label and gets no bullet or number. */
  list?: { kind: "bullet" | "number" | "none"; level: number; label?: string }
  /** AQU-2680: the whole paragraph is bold (italic): a PDF's subtitle, a quotation. */
  bold?: boolean
  italic?: boolean
}

/** AQU-2680: the list item a line's import recorded (`metadata.list`). */
function listOf(cell: CellData): LinesParagraph["list"] {
  const kind = cell.metadata?.list
  if (kind !== "bullet" && kind !== "number" && kind !== "none") return undefined
  const level = Number(cell.metadata?.listLevel)
  const label = typeof cell.metadata?.listLabel === "string" ? cell.metadata.listLabel.trim() : ""
  return { kind, level: Number.isInteger(level) ? Math.min(8, Math.max(0, level)) : 0, ...(label ? { label } : {}) }
}

/** The lines' text as the export writes it: the translation, else the source. */
function lineText(cell: CellData): string {
  return (cell.translated || effectiveSourceText(cell) || "").trim()
}

function headingStyle(cell: CellData): string | null {
  if (cell.type !== "heading") return null
  if (cell.context === "Title") return "Title"
  const level = Number(/^Heading (\d)$/.exec(cell.context ?? "")?.[1] ?? 1)
  return `Heading${Math.min(6, Math.max(1, level))}`
}

/** Group the lines into paragraphs (see the module comment). */
export function linesToParagraphs(cells: readonly CellData[]): LinesParagraph[] {
  const byStarts = cells.some((c) => c.paragraphStart === true)
  const paragraphs: LinesParagraph[] = []
  let prev: CellData | null = null
  for (const cell of cells) {
    const text = lineText(cell)
    if (!text) continue
    const style = headingStyle(cell)
    const { lines } = cellLines(text)
    if (lines.length === 0) continue
    const runs = lines.map((l) => l.runs)
    const current = paragraphs[paragraphs.length - 1]
    const continues = current !== undefined && prev !== null
      && style === null && current.style === null
      && (byStarts ? cell.paragraphStart !== true : Boolean(cell.group) && cell.group === prev.group)
    if (continues) {
      // joined with one space, as the other exports join a paragraph's lines
      const last = current.lines[current.lines.length - 1]
      last.push({ kind: "text", text: " ", marks: [], roles: [] }, ...runs[0])
      current.lines.push(...runs.slice(1))
    } else {
      const list = style === null ? listOf(cell) : undefined
      paragraphs.push({
        style, lines: runs, ...(list ? { list } : {}),
        ...(cell.metadata?.paragraphBold === true ? { bold: true } : {}),
        ...(cell.metadata?.paragraphItalic === true ? { italic: true } : {}),
      })
    }
    prev = cell
  }
  return paragraphs
}

// Characters XML 1.0 cannot hold at all.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const escapeXml = (s: string) =>
  s.replace(XML_INVALID, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Text runs for a piece of text: tabs and newlines as Word's own elements. */
function textRuns(text: string, rPr: string): string {
  let out = ""
  for (const piece of text.split(/(\t|\r?\n)/)) {
    if (piece === "") continue
    if (piece === "\t") out += `<w:r>${rPr}<w:tab/></w:r>`
    else if (piece === "\n" || piece === "\r\n") out += `<w:r>${rPr}<w:br/></w:r>`
    else out += `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(piece)}</w:t></w:r>`
  }
  return out
}

/** AQU-2680: a run's properties, in the schema's order (bold, italic, then
 *  right-to-left). Bold and italic come from the run's inline marks. */
function runProps(marks: readonly string[], rtl: boolean): string {
  const bold = marks.includes("bold")
  const italic = marks.includes("italic")
  if (!bold && !italic && !rtl) return ""
  return `<w:rPr>${bold ? "<w:b/><w:bCs/>" : ""}${italic ? "<w:i/><w:iCs/>" : ""}${rtl ? "<w:rtl/>" : ""}</w:rPr>`
}

interface Built {
  documentXml: string
  footnotesXml: string | null
  /** AQU-2680: present only when the document has list items. */
  numberingXml: string | null
}

/** AQU-2680: bullets use one list definition (numId 1). Each numbered list
 *  gets its own numId. Review finding 2: a numbered list carries on across
 *  the paragraphs between its items while its labels count on ("3." after
 *  "2."); where a label says another number (1, a, i, or a "7." after "2.")
 *  or changes form ("a)" after "3."), a list starts at that number. A list
 *  item at a shallower level ends the lists below it. With no label recorded
 *  (a file imported before labels were kept), a list starts again after any
 *  other paragraph, as before. */
const BULLET_NUM_ID = 1
const BULLETS = ["\u2022", "\u25e6", "\u25aa"]
const NUMBER_FORMATS = ["decimal", "lowerLetter", "lowerRoman"]

type NumberFormat = "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman"

/** AQU-2680 review findings 2 and 7: a numbered label read: its form (what comes
 *  before and after the number, and the number's kind) and its value. */
interface ParsedLabel { format: NumberFormat; value: number; before: string; after: string }

function romanValue(s: string): number {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
  let total = 0
  const lower = s.toLowerCase()
  for (let k = 0; k < lower.length; k++) {
    const cur = v[lower[k]]
    const next = v[lower[k + 1]] ?? 0
    total += cur < next ? -cur : cur
  }
  return total
}

/** "1.", "a)", "(iv)", "1.1.3.": the leading parts of a "1.1.3." stay as
 *  written. A lone "i" (or "v", "x"…) is a letter when the list it would
 *  carry on counts in letters, else "i" is a roman one. */
function parseLabel(label: string, current: NumberFormat | null): ParsedLabel | null {
  const m = /^(\(?)((?:\d+\.)*)(\d+|[a-z]+|[A-Z]+)([.)]?)$/.exec(label.trim())
  if (!m) return null
  const [, open, parts, n, close] = m
  const before = open + parts
  if (/^\d+$/.test(n)) return { format: "decimal", value: Number(n), before, after: close }
  if (parts) return null
  const upper = n === n.toUpperCase()
  const letter = n.length === 1 && (current === "lowerLetter" || current === "upperLetter" || !/^[iI]$/.test(n))
  if (letter) return { format: upper ? "upperLetter" : "lowerLetter", value: n.toLowerCase().charCodeAt(0) - 96, before, after: close }
  if (/^[ivxlcdm]+$/i.test(n)) return { format: upper ? "upperRoman" : "lowerRoman", value: romanValue(n), before, after: close }
  return null
}

function lvl(level: number, start: number, fmt: string, text: string, hanging = 360): string {
  return `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${escapeXml(text)}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="${hanging}"/></w:pPr></w:lvl>`
}

function levels(kind: "bullet" | "number"): string {
  let out = ""
  for (let l = 0; l < 9; l++) {
    out += kind === "bullet" ? lvl(l, 1, "bullet", BULLETS[l % 3]) : lvl(l, 1, NUMBER_FORMATS[l % 3], `%${l + 1}.`)
  }
  return out
}

/** One numbered list: where it starts, and its label's form when known. */
interface NumberedList { numId: number; level: number; start: number; label: ParsedLabel | null; items: number }

function numberingXml(lists: readonly NumberedList[]): string {
  let nums = `<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>`
  for (const list of lists) {
    const label = list.label
    // a wide label ("1.1.3.") gets a wider hanging indent
    const own = label ? lvl(list.level, list.start, label.format, `${label.before}%${list.level + 1}${label.after}`, label.before.length + label.after.length > 2 ? 720 : 360) : ""
    nums += `<w:num w:numId="${list.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${list.level}"><w:startOverride w:val="${list.start}"/>${own}</w:lvlOverride></w:num>`
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:numbering xmlns:w="${W_NS}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels("bullet")}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels("number")}</w:abstractNum>` +
    `${nums}</w:numbering>`
}

/** AQU-2680: the page size a line's import recorded (a PDF's, in points),
 *  when it is a plausible page (1 to 22 inches a side). */
function pageSizeOf(cells: readonly CellData[]): { width: number; height: number } | null {
  for (const cell of cells) {
    const size = cell.metadata?.pageSize as { width?: unknown; height?: unknown } | undefined
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 72 && v <= 1584
    if (size && ok(size.width) && ok(size.height)) return { width: size.width, height: size.height }
  }
  return null
}

/** The page: the recorded size, else A4 (in twentieths of a point). */
function pageSizeXml(size: { width: number; height: number } | null): string {
  if (!size) return `<w:pgSz w:w="11906" w:h="16838"/>`
  const w = Math.round(size.width * 20)
  const h = Math.round(size.height * 20)
  return `<w:pgSz w:w="${w}" w:h="${h}"${w > h ? ` w:orient="landscape"` : ""}/>`
}

/** The document and footnote parts for these paragraphs. */
export function buildDocxParts(paragraphs: readonly LinesParagraph[], pageSize: { width: number; height: number } | null = null): Built {
  const footnotes: string[] = []
  const body: string[] = []
  let anyList = false
  const numbered: NumberedList[] = []
  /** The numbered list open at each level. */
  let open: (NumberedList | undefined)[] = []
  let prevList = false
  for (const p of paragraphs) {
    const plain = p.lines.flat().map((r) => r.text).join("")
    const rtl = detectStrongTextDirection(plain) === "rtl"
    let numPr = ""
    let ind = ""
    if (p.list) {
      anyList = true
      const level = p.list.level
      // a list item ends the lists below its level
      open = open.slice(0, level + 1)
      if (p.list.kind === "number") {
        const cur = open[level]
        const label = p.list.label ? parseLabel(p.list.label, cur?.label?.format ?? null) : null
        const sameForm = cur?.label && label && cur.label.format === label.format && cur.label.before === label.before && cur.label.after === label.after
        const carriesOn = cur !== undefined && (label ? sameForm && label.value === cur.start + cur.items : prevList && !cur.label)
        if (!carriesOn) {
          const list: NumberedList = { numId: BULLET_NUM_ID + 1 + numbered.length, level, start: label?.value ?? 1, label, items: 0 }
          numbered.push(list)
          open[level] = list
        }
        open[level]!.items++
        numPr = `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${open[level]!.numId}"/></w:numPr>`
      } else if (p.list.kind === "bullet") {
        numPr = `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${BULLET_NUM_ID}"/></w:numPr>`
      } else {
        // review finding 7: no label, so no bullet or number; set in line with the items' text
        ind = `<w:ind w:left="${720 * (level + 1)}"/>`
      }
    }
    prevList = Boolean(p.list)
    const style = p.style ?? (p.list ? "ListParagraph" : null)
    // the schema's order: style, numbering, right-to-left, then indent
    const pPr = style || rtl
      ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${numPr}${rtl ? "<w:bidi/>" : ""}${ind}</w:pPr>`
      : ""
    const rPr = rtl ? "<w:rPr><w:rtl/></w:rPr>" : ""
    let runs = ""
    p.lines.forEach((line, i) => {
      if (i > 0) runs += `<w:r>${rPr}<w:br/></w:r>`
      for (const run of line) {
        if (run.kind === "text") {
          runs += textRuns(run.text, runProps([...run.marks, ...(p.bold ? ["bold"] : []), ...(p.italic ? ["italic"] : [])], rtl))
          continue
        }
        const note = run.text.trim()
        if (!note) continue
        const id = footnotes.length + 1
        footnotes.push(
          `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/>${detectStrongTextDirection(note) === "rtl" ? "<w:bidi/>" : ""}</w:pPr>` +
          `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>` +
          `<w:r><w:t xml:space="preserve"> ${escapeXml(note)}</w:t></w:r></w:p></w:footnote>`,
        )
        runs += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
      }
    })
    body.push(`<w:p>${pPr}${runs}</w:p>`)
  }
  const sectPr = `<w:sectPr>${pageSizeXml(pageSize)}` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body.join("")}${sectPr}</w:body></w:document>`
  const footnotesXml = footnotes.length === 0 ? null : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:footnotes xmlns:w="${W_NS}" xmlns:r="${R_NS}">` +
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
    `${footnotes.join("")}</w:footnotes>`
  return { documentXml, footnotesXml, numberingXml: anyList ? numberingXml(numbered) : null }
}

const heading = (id: string, name: string, size: number, outline: number | null) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${outline === null ? 10 : 9}"/><w:qFormat/>` +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="120"/>${outline === null ? "" : `<w:outlineLvl w:val="${outline}"/>`}</w:pPr>` +
  `<w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`

/** AQU-2680: written only when the document has list items. */
const LIST_PARAGRAPH_STYLE = `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>` +
  `<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`

export function stylesXml(lang: string | null, options?: { lists?: boolean }): string {
  const langEl = lang ? `<w:lang w:val="${escapeXml(lang)}"/>` : ""
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:styles xmlns:w="${W_NS}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/>${langEl}</w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    heading("Title", "Title", 56, null) +
    heading("Heading1", "heading 1", 32, 0) +
    heading("Heading2", "heading 2", 28, 1) +
    heading("Heading3", "heading 3", 26, 2) +
    heading("Heading4", "heading 4", 24, 3) +
    heading("Heading5", "heading 5", 22, 4) +
    heading("Heading6", "heading 6", 22, 5) +
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
    `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
    `<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    (options?.lists ? LIST_PARAGRAPH_STYLE : "") +
    `</w:styles>`
}

export function settingsXml(hasFootnotes: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:settings xmlns:w="${W_NS}">` +
    (hasFootnotes ? `<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>` : "") +
    `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>` +
    `</w:settings>`
}

/** A BCP 47 tag Word can carry, or null ("und" and empty carry none). */
function wordLang(lang: string | undefined): string | null {
  const tag = (lang ?? "").trim()
  if (!tag || tag === "und" || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return null
  return tag
}

export interface DocxFromLinesOptions {
  /** The language the document is written in (the export's target language). */
  lang?: string
}

/** Every part of the package, by its path. */
export function docxFromLinesFiles(cells: readonly CellData[], options?: DocxFromLinesOptions): Record<string, string> {
  const { documentXml, footnotesXml, numberingXml } = buildDocxParts(linesToParagraphs(cells), pageSizeOf(cells))
  const rels = [
    `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="${R_NS}/settings" Target="settings.xml"/>`,
    ...(footnotesXml ? [`<Relationship Id="rId3" Type="${R_NS}/footnotes" Target="footnotes.xml"/>`] : []),
    ...(numberingXml ? [`<Relationship Id="rId4" Type="${R_NS}/numbering" Target="numbering.xml"/>`] : []),
  ]
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`,
    ...(footnotesXml ? [`<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`] : []),
    ...(numberingXml ? [`<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`] : []),
  ]
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  return {
    "[Content_Types].xml": `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`,
    "_rels/.rels": `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
    "word/document.xml": documentXml,
    "word/styles.xml": stylesXml(wordLang(options?.lang), { lists: numberingXml !== null }),
    "word/settings.xml": settingsXml(footnotesXml !== null),
    ...(footnotesXml ? { "word/footnotes.xml": footnotesXml } : {}),
    ...(numberingXml ? { "word/numbering.xml": numberingXml } : {}),
  }
}

/** The Word document, zipped. */
export async function exportDocxFromLines(cells: readonly CellData[], options?: DocxFromLinesOptions): Promise<Blob> {
  const { default: JSZip } = await import("jszip")
  const zip = new JSZip()
  const files = docxFromLinesFiles(cells, options)
  // [Content_Types].xml first, as Word writes it.
  for (const name of Object.keys(files)) zip.file(name, files[name])
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", mimeType: DOCX_MIME })
  return new Blob([bytes], { type: DOCX_MIME })
}
