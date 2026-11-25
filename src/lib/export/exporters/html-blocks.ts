// AQU-2184: the typeset half of the HTML export (AQU-2182's page). Pure —
// cell text in, escaped HTML fragments out, no page assembly and no DOM.
//
// AQU-2182 printed one plain block per verse with every inline marker stripped:
// readable, but Psalms lost their poetry lines, prose lost its paragraphs, and
// the team's footnotes vanished. This module is where the book's structure
// comes back:
//
//   * `cellLines` splits one cell's raw text into the LINES it renders as.
//     `segmentUsfmForDisplay` (the same transform the editor reads with)
//     already hands over breaks with their indent level, notes parsed, and the
//     character marks in force, so this is a regrouping, not a second parser.
//   * `blockClass` maps a paragraph's USFM marker — the one the import kept in
//     `CellData.paragraphMarker` — to the page's CSS class, which is how a
//     `\q2` line ends up indented further than a `\q1` one.
//   * `NoteCollector` numbers notes per section and renders the marker/notes
//     list pair, so the markers restart at every chapter and a notes list only
//     ever holds notes from verses that are actually on the page (validated
//     only, a chapter range and hidden cells all drop cells before we see
//     them).
//
// Everything that reaches the page goes through `escapeHtml` — including note
// text and a note's origin reference, which are cell text like any other.

import type { UsfmInlineMark, UsfmNotePart } from "@/lib/parsers/usfm-display"
import { segmentUsfmForDisplay, TABLE_ROLE_PREFIX } from "@/lib/parsers/usfm-display"
import { t } from "@/lib/i18n/standalone"
import { detectStrongTextDirection } from "@/lib/text-direction"

/** One inline piece of a rendered line. */
export type InlineRun =
  | { kind: "text"; text: string; marks: readonly UsfmInlineMark[]; roles: readonly string[]; attributes?: string }
  | { kind: "note"; noteKind: "footnote" | "endnote" | "xref"; ref: string; text: string; parts?: readonly UsfmNotePart[] }

/** One rendered line of a cell — a break marker inside the cell ends a line. */
export interface CellLine {
  /** 0 for prose; 1-4 for a poetry/list line, from its break marker's level. */
  indent: number
  /** A `\b` (blank line) stood between this line and the one before it. */
  blankBefore: boolean
  runs: InlineRun[]
}

/** One cell's rendered lines, plus a `\b` left hanging at its end. */
export interface CellText {
  lines: CellLine[]
  /** A `\b` closed the cell with nothing after it — in USFM that blank line
   *  separates this cell from the NEXT one, so only the caller, who can see
   *  both, can place it. */
  trailingBlank: boolean
}

/**
 * Split one cell's raw text into its rendered lines.
 *
 * Text with no USFM marker at all is one prose line, verbatim — a plain
 * translation is never reinterpreted. Inside USFM, newlines are USFM's own
 * line wrapping (not content), so they collapse to single spaces; the only
 * real line breaks are the break markers.
 */
export function cellLines(raw: string): CellText {
  const segments = segmentUsfmForDisplay(raw)
  if (segments === null) {
    const text = raw.trim()
    return {
      lines: text === "" ? [] : [{ indent: 0, blankBefore: false, runs: [{ kind: "text", text, marks: NO_MARKS, roles: NO_ROLES }] }],
      trailingBlank: false,
    }
  }

  const lines: CellLine[] = []
  let indent = 0
  let blankBefore = false
  let runs: InlineRun[] = []

  const flush = () => {
    const trimmed = trimRuns(runs)
    if (trimmed.length > 0) {
      lines.push({ indent, blankBefore, runs: trimmed })
      blankBefore = false
    }
    runs = []
  }

  for (const seg of segments) {
    if (seg.kind === "break") {
      // A `\b` is vertical space, not a new line style: it keeps the indent
      // and marks the NEXT line as preceded by a blank.
      if (seg.blank) {
        flush()
        blankBefore = true
        continue
      }
      flush()
      indent = seg.indent
      continue
    }
    if (seg.kind === "note") {
      runs.push({ kind: "note", noteKind: seg.noteKind, ref: seg.ref, text: seg.text, parts: seg.parts })
      continue
    }
    // `~` is USFM's no-break space, and stays one (AQU-2182). Only reached
    // inside text that is USFM at all, so a plain translation containing a
    // tilde is never touched. Everything else that is whitespace collapses:
    // inside USFM a newline is the file's own line wrapping, not content.
    const text = seg.text.replace(/~/g, NBSP).replace(SPACE_RUN, " ")
    if (text === "") continue
    runs.push({ kind: "text", text, marks: seg.marks, roles: seg.roles, ...(seg.attributes ? { attributes: seg.attributes } : {}) })
  }
  flush()
  return { lines, trailingBlank: blankBefore }
}

/** Drop the outer whitespace of a line's runs and any run left empty. */
function trimRuns(runs: readonly InlineRun[]): InlineRun[] {
  const out = runs.map((run) => ({ ...run }))
  const firstText = out.findIndex((r) => r.kind === "text")
  if (firstText !== -1) {
    const run = out[firstText]
    if (run.kind === "text") run.text = run.text.replace(LEADING_SPACE, "")
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const run = out[i]
    if (run.kind !== "text") break
    run.text = run.text.replace(TRAILING_SPACE, "")
    break
  }
  return out.filter((run) => run.kind !== "text" || run.text !== "")
}

const NO_MARKS: readonly UsfmInlineMark[] = Object.freeze([])
const NO_ROLES: readonly string[] = Object.freeze([])

const NBSP = "\u00a0"
/** Whitespace EXCEPT the no-break space, which is content here. */
const SPACE_RUN = /[^\S\u00a0]+/g
const LEADING_SPACE = /^[^\S\u00a0]+/
const TRAILING_SPACE = /[^\S\u00a0]+$/

/** The element each visual mark renders as, applied outermost-first. */
const MARK_WRAPPERS: Record<UsfmInlineMark, { open: string; close: string }> = {
  bold: { open: "<strong>", close: "</strong>" },
  italic: { open: "<em>", close: "</em>" },
  "small-caps": { open: '<span class="small-caps">', close: "</span>" },
  superscript: { open: "<sup>", close: "</sup>" },
}

/**
 * Character markers that carry meaning but no bold/italic mark of their own:
 * role (`usfm-markers.ts`) → the page's class. The look of each follows the
 * shared scripture editor Paratext 10 uses (its `usj-nodes.css`), so a book
 * reads here as it does there: a key term is bold italic, a proper name is
 * underlined, a transliterated word is italic. Two differences, on purpose: a
 * key term and a glossary word say what they are on hover, and a glossary
 * word gets a dotted underline (that editor shows it as plain text).
 */
const ROLE_CLASS: Record<string, string> = {
  "words-of-jesus": "wj",
  keyword: "key-term",
  "wordlist-entry": "glossary-word",
  "wordlist-greek": "glossary-word",
  "wordlist-hebrew": "glossary-word",
  "wordlist-aramaic": "glossary-word",
  "wordlist-real": "glossary-word",
  "proper-name": "proper-name",
  "geographic-name": "place-name",
  "proper-name-added": "proper-name-added",
  "quoted-text": "quoted-text",
  "book-quote": "c-italic",
  transliterated: "c-italic",
  signature: "c-italic",
  "secondary-source": "c-italic",
  deuterocanon: "c-italic",
  selah: "selah",
  "acrostic-char": "c-italic",
  "list-total": "c-italic",
  "list-key": "c-italic",
  "intro-quoted-text": "c-italic",
  "inline-quote-ref": "quote-ref",
  ordinal: "ordinal",
  "link-text": "link-text",
  pronunciation: "pronunciation",
  "verse-alt": "alt-number",
  "verse-published": "alt-number",
  "chapter-alt": "alt-number",
  "figure-caption": "figure-caption",
}

/** Roles whose hover text names them; the attribute payload follows when there is one. */
const ROLE_TITLE: Record<string, string> = {
  keyword: "Key term",
  "wordlist-entry": "Glossary word",
  "wordlist-greek": "Greek word list",
  "wordlist-hebrew": "Hebrew word list",
  "wordlist-aramaic": "Aramaic word list",
  "wordlist-real": "Glossary word",
}

/** `lemma="grace" strong="G5485"` → `lemma: grace, strong: G5485`; a bare
 *  default value reads as it is. */
function attributeText(attributes: string): string {
  const pairs = [...attributes.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)]
  if (pairs.length === 0) return attributes
  return pairs.map(([, key, value]) => `${key}: ${value}`).join(", ")
}

/** A ruby gloss, from `\rb base|gloss="…"\rb*` or the bare default form. */
function rubyGloss(attributes: string | undefined): string | null {
  if (!attributes) return null
  const named = attributes.match(/gloss\s*=\s*"([^"]*)"/)
  if (named) return named[1]
  return attributes.includes("=") ? null : attributes
}

function textRunHtml(run: InlineRun & { kind: "text" }): string {
  let html = escapeHtml(run.text)
  for (const mark of [...run.marks].reverse()) {
    const wrapper = MARK_WRAPPERS[mark]
    html = `${wrapper.open}${html}${wrapper.close}`
  }
  for (const role of [...run.roles].reverse()) {
    if (role === "ruby-base") {
      const gloss = rubyGloss(run.attributes)
      if (gloss) html = `<ruby>${html}<rt>${escapeHtml(gloss)}</rt></ruby>`
      continue
    }
    const cls = ROLE_CLASS[role]
    if (!cls) continue
    const name = ROLE_TITLE[role]
    const detail = name && run.attributes ? `${name} (${attributeText(run.attributes)})` : name
    html = `<span class="${cls}"${detail ? ` title="${escapeHtml(detail)}"` : ""}>${html}</span>`
  }
  return html
}

/** The table cell a run sits in (`table:tc1:2`), or null outside a table. */
function tableRole(run: InlineRun): string | null {
  if (run.kind !== "text") return null
  return run.roles.find((role) => role.startsWith(TABLE_ROLE_PREFIX)) ?? null
}

/** Is this line a table row (`\tr \th1 … \tc1 …`)? */
export function isTableRow(line: CellLine): boolean {
  return line.runs.some((run) => tableRole(run) !== null)
}

/** `table:thr1:2` → the cell's classes: heading or not, and its alignment. */
function tableCellClass(role: string): string {
  const marker = role.slice(TABLE_ROLE_PREFIX.length).split(":")[0].replace(/[\d-]+$/, "")
  const align = marker.endsWith("r") && marker !== "tr" ? " cell-right" : marker.endsWith("cc") || marker === "thc" ? " cell-centered" : ""
  return `table-cell${marker.startsWith("th") ? " table-head" : ""}${align}`
}

/** Marker-free, escaped, styled inline HTML for one line's runs. A table
 *  row's runs are grouped into its cells. */
export function lineInlineHtml(line: CellLine, notes?: NoteCollector): string {
  const runHtml = (run: InlineRun) => (run.kind === "note" ? (notes ? notes.marker(run) : "") : textRunHtml(run))
  if (!isTableRow(line)) return line.runs.map(runHtml).join("")
  // A note has no role of its own: it stays in the cell it follows.
  const cells: { role: string | null; html: string }[] = []
  for (const run of line.runs) {
    const role = run.kind === "note" ? (cells[cells.length - 1]?.role ?? null) : tableRole(run)
    const last = cells[cells.length - 1]
    if (last && last.role === role) last.html += runHtml(run)
    else cells.push({ role, html: runHtml(run) })
  }
  return cells
    .map((cell) => (cell.role ? `<span class="${tableCellClass(cell.role)}">${cell.html.trim()}</span>` : cell.html))
    .join("")
}

/**
 * The CSS class for a block, from the USFM paragraph marker that opened it.
 *
 * `indent` is a break marker's own level inside a cell and wins when it is
 * non-zero: `\q1 … \q2 …` inside one verse is two lines at two levels
 * whatever the paragraph opened as.
 */
export function blockClass(marker: string | undefined, indent: number): string {
  if (indent > 0) return `poetry poetry-${clampLevel(indent)}`
  if (!marker) return "para"
  const level = clampLevel(parseInt(marker.replace(/^[a-z]+/, ""), 10) || 1)
  const base = marker.replace(/\d+$/, "")
  switch (base) {
    case "q":
    case "qm":
      return `poetry poetry-${level}`
    case "qc":
      return "poetry poetry-centered"
    case "qr":
      return "poetry poetry-right"
    case "m":
    case "nb":
    case "lf":
      return "para para-flush"
    case "mi":
    case "pmo":
    case "pmc":
      return "para para-flush para-inset"
    case "pm":
    case "psi":
      return "para para-inset"
    case "pi":
      return `para para-indent-${level}`
    case "ph":
    case "phi":
      return `para para-hanging para-indent-${level}`
    case "pmr":
      return "para para-right para-inset"
    case "cls":
    case "lit":
      return "para para-right"
    case "qd":
      return "para para-flush poetry-note"
    case "io":
    case "ili":
      return `para list list-${level}`
    case "ipi":
      return "para para-inset"
    case "imi":
      return "para para-flush para-inset"
    case "ipq":
      return "para para-inset intro-quote"
    case "imq":
      return "para para-flush para-inset intro-quote"
    case "ipr":
      return "para para-right intro-quote"
    case "iq":
      return `poetry poetry-${level} intro-quote`
    case "im":
      return "para para-flush"
    case "li":
    case "lim":
      return `para list list-${level}`
    case "pc":
      return "para para-centered"
    case "pr":
      return "para para-right"
    default:
      return "para"
  }
}

function clampLevel(level: number): number {
  return Math.min(Math.max(Number.isFinite(level) ? level : 1, 1), 4)
}

/**
 * Per-section note numbering and rendering.
 *
 * One collector per section (the front matter, or one chapter), so footnote
 * markers restart at `1` in every chapter and the notes list under a chapter
 * holds only the notes of the verses printed in it. Footnotes and endnotes are
 * numbered; cross-references are lettered, which is the usual convention and
 * what makes the two kinds distinguishable both inline and in the list.
 */
export interface NoteCollector {
  /** The superscript marker for a note, registering it in this section. */
  marker(note: InlineRun & { kind: "note" }): string
  /** The section's notes list, or "" when the section printed no notes. */
  listHtml(): string
}

export function createNoteCollector(sectionId: string): NoteCollector {
  const entries: { id: string; label: string; note: InlineRun & { kind: "note" } }[] = []
  let noteCount = 0
  let xrefCount = 0

  return {
    marker(note) {
      const isXref = note.noteKind === "xref"
      const label = isXref ? letterLabel(++xrefCount) : String(++noteCount)
      const id = `${sectionId}-${isXref ? "x" : "n"}${isXref ? xrefCount : noteCount}`
      entries.push({ id, label, note })
      // The note's text on hover, as the shared scripture editor shows it.
      const title = note.text ? ` title="${escapeHtml(note.text)}"` : ""
      return `<sup class="note-marker ${isXref ? "xref" : "footnote"}"><a id="${id}-ref" href="#${id}"${title}>${escapeHtml(label)}</a></sup>`
    },
    listHtml() {
      if (entries.length === 0) return ""
      // AQU-2680 re-check finding 2: the app's words, not fixed English (the
      // page has no catalog in the target language), and each note in its own
      // direction, so an Arabic or Hebrew note reads right to left.
      const title = escapeHtml(t("importExport.htmlPage.notes"))
      const back = escapeHtml(t("importExport.htmlPage.backToText"))
      const items = entries.map((entry) => {
        const kind = entry.note.noteKind === "xref" ? "xref" : "footnote"
        const ref = entry.note.ref ? `<span class="note-ref">${escapeHtml(entry.note.ref)}</span> ` : ""
        const dir = detectStrongTextDirection(entry.note.text) === "rtl" ? ` dir="rtl"` : ""
        return (
          `<li class="note ${kind}" id="${entry.id}"${dir}>` +
          `<a class="note-back" href="#${entry.id}-ref" aria-label="${back}">${escapeHtml(entry.label)}</a> ` +
          `${ref}<span class="note-text">${noteTextHtml(entry.note)}</span></li>`
        )
      })
      return `<aside class="notes" aria-label="${title}">\n<h3 class="notes-title">${title}</h3>\n<ul>\n${items.join("\n")}\n</ul>\n</aside>`
    },
  }
}

/** A note's own markers → the class its text gets in the notes list: the
 *  words quoted from the verse and an alternative rendering are italic, a
 *  keyword and a label are bold italic, a verse number is raised. */
const NOTE_PART_CLASS: Record<string, string> = {
  fq: "note-quote",
  fqa: "note-quote",
  xq: "note-quote",
  xk: "note-quote",
  fk: "note-keyword",
  fl: "note-keyword",
  fv: "note-verse",
  fm: "note-verse",
}

function noteTextHtml(note: InlineRun & { kind: "note" }): string {
  if (!note.parts || note.parts.length === 0) return escapeHtml(note.text)
  return note.parts
    .map((part) => {
      const cls = NOTE_PART_CLASS[part.marker]
      const text = escapeHtml(part.text)
      // `\fp` opens a further paragraph of the same note.
      const lead = part.marker === "fp" ? "<br>" : ""
      return cls ? `${lead}<span class="${cls}">${text}</span>` : `${lead}${text}`
    })
    .join("")
}

/** 1 → "a", 26 → "z", 27 → "aa" — cross-reference labels. */
function letterLabel(n: number): string {
  let out = ""
  let i = n
  while (i > 0) {
    const rem = (i - 1) % 26
    out = String.fromCharCode(97 + rem) + out
    i = Math.floor((i - 1) / 26)
  }
  return out
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
