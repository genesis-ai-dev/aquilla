// Writing an xlsx, not just reading one. (AQU-646, 2026-08-19)
//
// The app has been able to READ xlsx since AQU-316 — `src/lib/parsers/spreadsheet.ts`,
// a hand-rolled JSZip-and-regex reader with no SheetJS behind it. It has never
// been able to write one, and writing is the half Anna needs. She owns the
// character spreadsheets; she brings them to us to find the rows where her two
// sheets disagree with each other, she resolves them here — and then the
// corrected sheet has to go back into her pipeline, which eats xlsx. Handing
// her a CSV instead means she opens it in Excel and saves it again herself,
// which loses the highlighting that says WHICH cells we changed, and quietly
// pushes a conversion step onto the client that we could have done for her.
//
// SheetJS was the obvious answer and lost on weight: a whole spreadsheet engine
// — formulas, number formats, forty file formats — to emit a few hundred bytes
// of XML into a zip we already ship a zip library for. The usual objection to
// hand-rolling a format is that you get it subtly wrong and find out at the
// worst possible moment; that is why the tests here round-trip everything back
// through our OWN reader rather than asserting on the XML this file just wrote.
// Reader and writer are two halves of one pair, and the tests hold them together.
//
// INLINE STRINGS, NOT A SHARED-STRINGS TABLE. Both are legal and — checked
// before choosing, because it decides whether the round-trip test can pass at
// all — the reader handles both: `parseSheetXml` has a `t="s"` branch and a
// separate `t="inlineStr"` branch, and both decode XML entities. So the choice
// was free, and inline won. A shared-strings table is a second part to keep in
// step with a dictionary of every distinct string in the workbook, and its
// entire reason to exist is deduplication across tens of thousands of rows. One
// episode's character sheet is a few hundred. The saving is nothing; the bug
// surface — one index off by one puts the wrong name against every line after
// it — is not nothing.
//
// FIVE THINGS HERE ARE SHAPED BY OUR READER rather than by the spec. It is
// regexes over XML, not a parser, so the output has to sit inside what its
// patterns actually match:
//
//   - Attribute ORDER matters twice. The workbook regex wants `name` before
//     `r:id` on `<sheet>`, and the relationships regex wants `Id` before
//     `Target`. Swap either pair and the workbook reads back as having no
//     worksheets at all.
//   - Cells are never self-closing. The cell regex is `<c …>…</c>`, so a
//     `<c r="B2"/>` is invisible to it — which is exactly how an empty cell
//     would naturally be written, and would silently shorten a row whenever the
//     empty cell is the last one in it. Empty cells go out as empty inline
//     strings so they survive the trip.
//   - `<t></t>`, never `<t/>`, for the same reason: the `<t>` pattern requires
//     a closing tag.
//   - Exactly one `<t>` per cell. The inline branch reads only the FIRST one,
//     so rich-text runs would come back truncated. We have no per-run
//     formatting to carry anyway.
//   - Text may never contain a raw `<`, because the `<t>` capture group is
//     `([^<]*)`. Escaping deals with that, but it is why escaping is not
//     optional here even for text nobody would think of as markup.
//
// None of these are hardships — they are all also what Excel itself writes.
// They are recorded because "why is this attribute in this order" is otherwise
// the sort of thing a later tidy-up silently undoes.

import JSZip from "jszip"

export interface XlsxCell {
  value: string | number | null
  /** Draw attention to this cell — used to mark a corrected value. */
  highlight?: boolean
}

export interface XlsxSheet {
  /** Worksheet tab name. */
  name: string
  headers: string[]
  rows: XlsxCell[][]
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
const DOC_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

/**
 * The one styled cell format in the workbook, as an index into `cellXfs`.
 *
 * Index 0 is the default (no fill). Index 1 is the highlight. There is
 * deliberately no third: a general styling system — fonts, widths, number
 * formats, a style registry keyed by some options object — is a lot of code for
 * a feature nobody asked for, and the only visual thing this export has to say
 * is "we changed this one".
 */
const HIGHLIGHT_STYLE = 1

/** Excel's own forbidden set for worksheet tab names. */
const FORBIDDEN_TAB_CHARS = /[:\\/?*[\]]/g

/** Excel's cap. Anything longer is rejected on open, not truncated for you. */
const MAX_TAB_NAME_LENGTH = 31

/**
 * Strip the surrounding whitespace and apostrophes Excel refuses on a tab.
 *
 * BOTH, REPEATEDLY, and in that order — the first cut stripped apostrophes
 * before trimming, so ` 'Cast' ` kept both quotes: the anchors in `/^'+|'+$/`
 * cannot see past the spaces, and by the time `.trim()` ran the strip was
 * already spent. Alternating until it settles also handles `' Cast '`, where
 * removing the quotes exposes fresh spaces and removing the spaces exposes
 * fresh quotes.
 */
function tidyTabName(raw: string): string {
  let out = raw
  for (;;) {
    const next = out.trim().replace(/^'+|'+$/g, "")
    if (next === out) return next
    out = next
  }
}

// ─── Column letters ──────────────────────────────────────────────────────────

/**
 * 0 → "A", 25 → "Z", 26 → "AA", 701 → "ZZ", 702 → "AAA".
 *
 * This is bijective base-26, not ordinary base-26, and the difference is the
 * whole reason it has its own tests. There is no zero digit: after "Z" comes
 * "AA", not "BA", so each carry has to subtract one before it recurses. Get it
 * wrong and columns A through Z are perfect while every column past Z is
 * written one place to the side — which reads, in the delivered file, as the
 * character names having slid into the timecode column.
 */
export function columnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Column index must be a non-negative integer, got ${index}`)
  }
  let remaining = index
  let letters = ""
  while (remaining >= 0) {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters
    remaining = Math.floor(remaining / 26) - 1
  }
  return letters
}

// ─── Text safety ─────────────────────────────────────────────────────────────

/**
 * Drop the characters XML 1.0 has no way to represent at all.
 *
 * Not paranoia: these cells come from spreadsheets that came from other
 * spreadsheets, and a character name pasted out of one can carry a stray
 * vertical tab or a form feed from wherever it was typed. There is no escape
 * for them — `&#11;` is itself illegal in XML 1.0 — so the only options are
 * dropping them or emitting a file that no reader will open. We drop them.
 *
 * Lone surrogates go too. They are legal JavaScript string contents and cannot
 * be encoded as UTF-8, so leaving one in hands the zip a byte sequence that
 * whatever opens it will have to guess about.
 */
function stripInvalidXmlChars(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // C0 controls, except the three XML allows: tab, line feed, carriage return.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        out += text[i] + text[i + 1]
        i += 1
        continue
      }
      continue // High surrogate with nothing after it.
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue // Low surrogate on its own.
    if (code === 0xfffe || code === 0xffff) continue // Permanently unassigned.
    out += text[i]
  }
  return out
}

/**
 * Escape for both element text and attribute values, so there is one function
 * to be right rather than two to keep in agreement.
 *
 * All five predefined entities, including the two (`"` and `'`) that only
 * strictly need escaping inside attributes. Our reader decodes all five on the
 * way back in, so escaping the extra two costs a couple of bytes and buys the
 * guarantee that a sheet tab named `Anna's "final"` cannot terminate the
 * attribute it is sitting in.
 *
 * AND A CARRIAGE RETURN, which is the one that does not look like escaping at
 * all. A literal CR is legal in XML content — `stripInvalidXmlChars` keeps it
 * deliberately — but XML 1.0 §2.11 requires every conforming parser to
 * NORMALISE it to a line feed while reading. So a cell whose text contains
 * `\r\n` was written faithfully and read back as `\n`: the file was right and
 * the round trip was still lossy, which is the sort of bug that surfaces as
 * "the line breaks changed" three exports later. Writing `&#13;` survives
 * normalisation, and the reader decodes numeric references for exactly this.
 *
 * The ampersand is replaced FIRST, so the `&` it introduces cannot be
 * re-escaped by a later pass.
 */
export function escapeXml(text: string): string {
  return stripInvalidXmlChars(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;")
}

// ─── Sheet tab names ─────────────────────────────────────────────────────────

/**
 * Make a set of tab names Excel will actually open.
 *
 * Excel is unforgiving here and fails LOUDLY — a bad tab name does not render
 * oddly, it produces the "we found a problem with some content" dialog on a
 * file the client cannot then use at all. So: the six forbidden characters
 * become underscores (rather than being deleted, which would glue "Ep 101" and
 * "Cast" into "Ep 101Cast" with no sign anything happened), names are capped at
 * thirty-one characters, leading and trailing apostrophes go, and an empty
 * result falls back to a positional name.
 *
 * Duplicates are resolved case-INSENSITIVELY, because Excel considers "Cast"
 * and "cast" the same tab and will refuse a workbook containing both. The
 * suffix is Excel's own " (2)" convention, and the base is trimmed to make room
 * for it so the result stays inside the cap.
 */
export function sanitizeSheetNames(names: string[]): string[] {
  const taken = new Set<string>()
  return names.map((raw, index) => {
    let base = tidyTabName(stripInvalidXmlChars(raw).replace(FORBIDDEN_TAB_CHARS, "_"))
    if (!base) base = `Sheet${index + 1}`
    // Trimmed AGAIN after the cap: truncating at thirty-one characters can put
    // the cut right after an apostrophe and hand back the trailing quote the
    // first pass removed.
    base = tidyTabName(base.slice(0, MAX_TAB_NAME_LENGTH))
    if (!base) base = `Sheet${index + 1}`

    let candidate = base
    let attempt = 2
    while (taken.has(candidate.toLowerCase())) {
      const suffix = ` (${attempt})`
      candidate = `${tidyTabName(base.slice(0, MAX_TAB_NAME_LENGTH - suffix.length))}${suffix}`
      attempt += 1
    }
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

// ─── Cells and rows ──────────────────────────────────────────────────────────

/**
 * One `<c>`. Numbers get no `t` attribute (OOXML's default type is numeric);
 * everything else is an inline string.
 *
 * A number that is not finite becomes an empty cell rather than `<v>NaN</v>`,
 * which is not a valid xsd:double and would take the whole workbook down with
 * it. That is a real possibility: durations here are divisions, and a duration
 * over a zero-length clip arrives as NaN long before it reaches an export.
 */
function cellXml(ref: string, cell: XlsxCell | undefined): string {
  const style = cell?.highlight ? ` s="${HIGHLIGHT_STYLE}"` : ""
  const value = cell?.value

  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`
  }

  const text = typeof value === "string" ? value : ""
  // `xml:space="preserve"` only when it matters. Without it a value of "  " —
  // or a name with a trailing space, which sheets maintained by hand are full
  // of — is free to be collapsed away by a conforming reader.
  const preserve = text !== text.trim() ? ' xml:space="preserve"' : ""
  return `<c r="${ref}"${style} t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`
}

/**
 * One `<row>`, numbered from 1 as Excel numbers them.
 *
 * A row with no cells is written with an explicit closing tag rather than
 * self-closed, and that is not a style preference. Our reader matches rows
 * non-greedily from `<row …>` to the next `</row>`; a `<row r="5"/>` has no
 * `</row>` of its own, so the match runs on and swallows row six's cells as
 * though they belonged to row five. An empty `<row r="5"></row>` is skipped
 * cleanly instead. (It is still skipped — a caller who wants a blank spacer row
 * to survive the round trip should pass a row of null cells, which come back as
 * empty strings. Excel shows both as a blank row either way.)
 */
function rowXml(rowNumber: number, cells: readonly (XlsxCell | undefined)[]): string {
  if (cells.length === 0) return `<row r="${rowNumber}"></row>`
  const body = cells
    .map((cell, column) => cellXml(`${columnLetter(column)}${rowNumber}`, cell))
    .join("")
  return `<row r="${rowNumber}">${body}</row>`
}

function worksheetXml(sheet: XlsxSheet): string {
  const header = rowXml(1, sheet.headers.map((text) => ({ value: text })))
  const body = sheet.rows.map((cells, index) => rowXml(index + 2, cells)).join("")
  return `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetData>${header}${body}</sheetData></worksheet>`
}

// ─── The package parts ───────────────────────────────────────────────────────

/**
 * `styles.xml`, and it is the smallest one that Excel accepts rather than the
 * smallest one that is schema-valid.
 *
 * The two are not the same. Excel requires the first two fills to be exactly
 * `none` and `gray125`, in that order, and complains about the file if they are
 * missing — a legacy of how the built-in pattern list is indexed. So our single
 * solid fill is necessarily fill 2, and the highlight format in `cellXfs` is
 * necessarily index 1.
 *
 * The colour is Excel's own light amber, the same one its "Note" cell style
 * uses. Chosen because it survives being printed in greyscale and does not read
 * as an error the way red would: these cells are corrections, not problems.
 */
const STYLES_XML = `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}">`
  + '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>'
  + "</fills>"
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + `<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>`
  + "</cellXfs>"
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + "</styleSheet>"

const ROOT_RELS_XML = `${XML_DECLARATION}<Relationships xmlns="${RELS_NS}">`
  + `<Relationship Id="rId1" Type="${DOC_RELS_NS}/officeDocument" Target="xl/workbook.xml"/>`
  + "</Relationships>"

function contentTypesXml(sheetCount: number): string {
  const overrides = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("")
  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + overrides
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + "</Types>"
}

/** `name` before `r:id` — see the header. The reader's regex depends on it. */
function workbookXml(tabNames: readonly string[]): string {
  const sheets = tabNames
    .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")
  return `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_RELS_NS}"><sheets>${sheets}</sheets></workbook>`
}

/** `Id` before `Target`, for the same reason. Styles take the last rId. */
function workbookRelsXml(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="${DOC_RELS_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("")
  const stylesRel = `<Relationship Id="rId${sheetCount + 1}" Type="${DOC_RELS_NS}/styles" Target="styles.xml"/>`
  return `${XML_DECLARATION}<Relationships xmlns="${RELS_NS}">${sheetRels}${stylesRel}</Relationships>`
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a workbook: one worksheet per `XlsxSheet`, in the order given, each
 * with its headers as row 1 and its rows below.
 *
 * Rows do not have to be the same length as the headers or as each other —
 * whatever a row contains is what gets written, because a caller with a ragged
 * sheet is better served by a ragged file than by a writer silently inventing
 * cells to pad with.
 */
export async function buildXlsx(sheets: XlsxSheet[]): Promise<Blob> {
  if (sheets.length === 0) {
    throw new Error("A workbook must contain at least one sheet.")
  }

  const tabNames = sanitizeSheetNames(sheets.map((sheet) => sheet.name))
  const zip = new JSZip()

  // `[Content_Types].xml` goes in FIRST. JSZip writes members in insertion
  // order, and while most readers will hunt for the part wherever it is, the
  // Open Packaging Convention says it comes first and the strict ones enforce
  // it. Costs nothing to be right.
  zip.file("[Content_Types].xml", contentTypesXml(sheets.length))
  zip.file("_rels/.rels", ROOT_RELS_XML)
  zip.file("xl/workbook.xml", workbookXml(tabNames))
  zip.file("xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length))
  zip.file("xl/styles.xml", STYLES_XML)
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet))
  })

  return zip.generateAsync({ type: "blob", mimeType: XLSX_MIME, compression: "DEFLATE" })
}
