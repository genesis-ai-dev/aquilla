// HTML exporter (AQU-2182): one self-contained, readable web page of a USFM
// book — chapter index, numbered verses, section headings — for reviewers who
// do not have the app, and for printing. Codex's "Export as HTML" wrote a
// folder (an index page, one page per chapter, styles.css); this writes ONE
// file with the CSS inline and the index as same-page anchors, so it can be
// emailed or opened from disk with nothing beside it.
//
// Built from the cell array the dialog already scoped (hidden cells, validated
// only, chapter range, voice filter), like txt/md — never from the server-side
// USFM round-trip. Under the "current" content mode an untranslated line falls
// back to its source text (the mode's documented meaning; AQU-1451 kept that
// fallback for every text format) but is MARKED — `class="untranslated"`,
// muted on the page, counted in the footer — so a reviewer can tell approved
// translation from source filler, the AQU-1148 complaint. Under "validated
// only" the dialog has already dropped those cells, so nothing is filled.
//
// AQU-2184 — the book's layout, not one plain block per verse:
//
//   * Verses flow together inside the paragraph the book marks them in, and a
//     paragraph marker starts a new one. The structure is the SOURCE's, so a
//     Target page whose translations carry no markers still reads in the
//     source's paragraphs and poetry lines.
//   * Poetry lines each start on their own line, indented by level.
//   * Footnotes and cross-references become a superscript marker linked to a
//     numbered notes list at the end of that chapter, and back.
//   * Character styles (`\bd`, `\it`, `\nd`, `\wj`, …) survive as styling, and
//     headings, parallel-passage references and psalm titles each get their
//     own style — all from `html-blocks.ts`.
//
// A file with no paragraph structure at all — every non-scripture import —
// keeps AQU-2182's one-block-per-cell page, because inventing paragraph breaks
// it never imported would be a guess. Its inline markers are still typeset. A
// scripture file imported before AQU-2184 has `paragraphStart` (that predates
// this) but no marker, so its verses still flow in their paragraphs as prose;
// only the poetry level of a paragraph's FIRST line is missing, and its
// continuation lines, which carry their own markers in the cell text, indent
// as they should.
//
// Inline USFM markers never reach the page raw, and every piece of cell text
// is HTML-escaped — a translation that reads `<script>`, or a footnote whose
// text does, shows those characters and runs nothing.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { isStructuralCell } from "@/lib/cells/structural"
import { chapterLabelForCell } from "@/lib/export/chapter-scope"
import { blockClass, cellLines, escapeHtml, lineInlineHtml, createNoteCollector, type CellLine, type NoteCollector } from "@/lib/export/exporters/html-blocks"
import { parseScriptureReference } from "@/lib/scripture-reference"

export { escapeHtml }

export interface HtmlExportOptions {
  /** The exported file's name; its stem titles the page when no cell carries a
   *  scripture reference the book name can be read from. */
  fileName?: string | null
  /** True when the dialog's content mode left non-validated cells out — the
   *  footer says so, because the page cannot show what is absent. */
  validatedOnly?: boolean
  /** Language of the exported text, for `<html lang>`. Only a BCP-47-shaped
   *  tag (`fr`, `pt-BR`, `sw-Latn-KE`) is written; a display name ("Greek"),
   *  `und` or an empty value is skipped — a lane's language can be either. */
  lang?: string | null
  /** The export moment, for the footer. Injectable so tests are byte-stable. */
  now?: Date
}

/** The only fields the page reads; `CellData` satisfies it. */
export type HtmlExportCell = Pick<CellData, "translated" | "group" | "type" | "paragraphStart" | "paragraphMarker"> &
  Parameters<typeof effectiveSourceText>[0]

/**
 * Does this file read as a Bible book — does any line carry a Bible verse
 * reference (a known book code with a chapter and verse, `RUT 1:1`)?
 *
 * AQU-2210: a `codex` file is not always Scripture. Migrated projects hold
 * dubbing episodes (`TheChosen-101-en-5-2 1:cue-…`), Pilgrim's Progress
 * (`PilgrimsProgress 1:13`) and commentaries under the same type, and the file
 * row cannot tell them apart (no book code; Codex's corpus marker is not
 * migrated). The lines can, by the same reference test that numbers a verse
 * on the page — so a file offered the page gets numbered verses.
 */
export function hasBibleVerses(cells: readonly Pick<CellData, "group">[]): boolean {
  return cells.some((cell) => parseScriptureReference(cell.group)?.verse != null)
}

export function exportHtml(cells: readonly HtmlExportCell[], opts: HtmlExportOptions = {}): Blob {
  return new Blob([buildHtmlPage(cells, opts)], { type: "text/html;charset=utf-8" })
}

interface Entry {
  kind: "verse" | "heading" | "text"
  /** Verse number, or range ("1-2"), when the cell is a verse with a readable ref. */
  verse: string | null
  /** The heading's own USFM marker ("s1", "d", "r", "mt1"), read back from its
   *  synthetic reference; null for anything that is not a marked heading. */
  headingMarker: string | null
  lines: CellLine[]
  /** A `\b` ended this cell's text: the blank line it asks for belongs above
   *  whatever comes next, which is where `bodyHtml` puts it. */
  trailingBlank: boolean
  untranslated: boolean
  paragraphStart: boolean
  paragraphMarker: string | undefined
}

interface Chapter {
  id: string
  /** "Genesis 1", or the bare label for a chapter that is not a scripture ref. */
  title: string
  /** "1" in the index, or the bare label. */
  indexLabel: string
  entries: Entry[]
}

/** The page as a string — `exportHtml` wraps it in a Blob. */
export function buildHtmlPage(cells: readonly HtmlExportCell[], opts: HtmlExportOptions = {}): string {
  const leading: Entry[] = []
  const chapters: Chapter[] = []
  const byLabel = new Map<string, Chapter>()
  // Entries with no chapter of their own — front matter, an inserted cell with
  // no reference, a cell whose ref cannot be read — wait for the next
  // referenced cell and go where IT goes: a "Chapter 2" line someone inserted
  // above 2:1 introduces chapter 2, it does not close chapter 1. Before the
  // first chapter they are the front matter; after the last cell they stay
  // with the last chapter.
  let pending: Entry[] = []
  let untranslated = 0
  // The page only lays out paragraphs it actually imported (see the header).
  const flow = cells.some((cell) => cell.paragraphStart === true)

  for (const cell of cells) {
    const entry = entryFor(cell)
    if (!entry) continue
    if (entry.untranslated) untranslated++
    const label = chapterLabelForCell(cell)
    if (!label) {
      pending.push(entry)
      continue
    }
    let chapter = byLabel.get(label)
    if (!chapter) {
      chapter = chapterFor(label)
      byLabel.set(label, chapter)
      chapters.push(chapter)
      // Whatever waited ahead of the FIRST chapter is the front matter.
      if (chapters.length === 1) {
        leading.push(...pending)
        pending = []
      }
    }
    // Entries that waited ahead of this cell belong with it: inside the
    // chapter when it continues one, at the top of the chapter when it opens
    // one.
    chapter.entries.push(...pending, entry)
    pending = []
  }
  if (chapters.length === 0) leading.push(...pending)
  else chapters[chapters.length - 1].entries.push(...pending)

  const title = pageTitle(cells, opts.fileName)
  const lang = isLanguageTag(opts.lang) ? ` lang="${escapeHtml(opts.lang)}"` : ""
  const parts: string[] = []
  parts.push(`<h1 class="book-title">${escapeHtml(title)}</h1>`)
  if (chapters.length === 0) {
    // No chapters at all: the entries ARE the document, not front matter.
    parts.push(`<section class="chapter">\n${bodyHtml(leading, "doc", flow)}\n</section>`)
  } else {
    if (leading.length > 0) {
      parts.push(`<section class="front-matter">\n${leading.map(frontMatterHtml).join("\n")}\n</section>`)
    }
    parts.push(
      `<nav class="chapter-index" aria-label="Chapters">\n<h2>Chapters</h2>\n<ol>\n` +
        chapters.map((c) => `<li><a href="#${c.id}">${escapeHtml(c.indexLabel)}</a></li>`).join("\n") +
        `\n</ol>\n</nav>`,
    )
    for (const c of chapters) {
      parts.push(
        `<section class="chapter" id="${c.id}">\n<h2 class="chapter-title">${escapeHtml(c.title)}</h2>\n` +
          bodyHtml(c.entries, c.id, flow) +
          `\n</section>`,
      )
    }
  }
  parts.push(footerHtml(opts, untranslated))

  return (
    `<!DOCTYPE html>\n<html${lang}>\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>\n${CSS}\n</style>\n</head>\n<body>\n<main>\n` +
    parts.join("\n") +
    `\n</main>\n</body>\n</html>\n`
  )
}

function entryFor(cell: HtmlExportCell): Entry | null {
  const translated = cell.translated.trim()
  const untranslated = translated === ""
  const raw = untranslated ? effectiveSourceText(cell).trim() : translated
  if (!raw) return null
  const text = cellLines(raw)
  const lines = splitPlainLines(text.lines)
  if (lines.length === 0) return null
  // A USFM import types its verses `verse`; a migrated Codex book types every
  // verse `text` and says it is one only through its reference (AQU-2210). So
  // content whose reference reads as a verse is a verse, whatever its type —
  // a cue ref, a bare chapter ref or a structural cell never qualifies.
  const ref = parseScriptureReference(cell.group)
  const kind: Entry["kind"] =
    cell.type === "heading" ? "heading"
    : cell.type === "verse" || (ref?.verse && !isStructuralCell(cell.type)) ? "verse"
    : "text"
  const verse = kind === "verse" ? (ref?.verse ?? null) : null
  return {
    kind,
    verse,
    headingMarker: headingMarkerFromRef(cell.group),
    lines,
    trailingBlank: text.trailingBlank,
    untranslated,
    // Paragraph structure is the source's, and it rides the SOURCE row, so it
    // is read the same way whichever side's text is on the page.
    paragraphStart: cell.paragraphStart === true,
    paragraphMarker: cell.paragraphMarker,
  }
}

/** A newline inside plain (non-USFM) cell text is a line the author typed. */
function splitPlainLines(lines: readonly CellLine[]): CellLine[] {
  const out: CellLine[] = []
  for (const line of lines) {
    if (line.runs.length !== 1 || line.runs[0].kind !== "text" || !line.runs[0].text.includes("\n")) {
      out.push(line)
      continue
    }
    const run = line.runs[0]
    const pieces = run.text.split("\n").map((s) => s.trim()).filter((s) => s !== "")
    pieces.forEach((text, i) => {
      out.push({ indent: line.indent, blankBefore: i === 0 ? line.blankBefore : false, runs: [{ ...run, text }] })
    })
  }
  return out
}

/** One block of the page: a paragraph or a poetry line. */
interface Block {
  cls: string
  html: string
  /** The block's text is source filler, not translation (AQU-1148). */
  untranslated: boolean
  blankBefore: boolean
  /** This block is the continuation of the paragraph already open above it. */
  continues: boolean
}

/** The body of one section — its blocks, then the notes its verses carried. */
function bodyHtml(entries: readonly Entry[], sectionId: string, flow: boolean): string {
  const notes = createNoteCollector(sectionId)
  const out: string[] = []
  let current: Block | null = null
  // A `\b` at the end of one cell is the blank line above the next one.
  let pendingBlank = false

  const close = () => {
    if (current) out.push(renderBlock(current))
    current = null
  }

  for (const entry of entries) {
    if (entry.kind === "heading") {
      close()
      out.push(headingHtml(entry, notes))
      pendingBlank = false
      continue
    }
    const blocks = cellBlocks(entry, notes, flow)
    if (pendingBlank && blocks.length > 0) {
      blocks[0] = { ...blocks[0], blankBefore: true }
      pendingBlank = false
    }
    for (const block of blocks) {
      // In flow mode a verse that did not open a paragraph continues the one
      // above it — that is what makes verses read as prose rather than as a
      // list of lines, and it keeps a `\q2` line's indent across a verse
      // boundary, because the open block's own class is what it joins.
      if (current && block.continues && !block.blankBefore) {
        current.html += ` ${markedSpan(block, current)}`
        continue
      }
      close()
      current = { ...block }
    }
    if (entry.trailingBlank) pendingBlank = true
  }
  close()

  const list = notes.listHtml()
  return list === "" ? out.join("\n") : `${out.join("\n")}\n${list}`
}

/** Appended text whose translated/untranslated state differs from the
 *  paragraph's keeps its own marking — the paragraph's class cannot say both. */
function markedSpan(block: Block, into: Block): string {
  if (block.untranslated === into.untranslated) return block.html
  return `<span class="${block.untranslated ? "untranslated" : "translated"}">${block.html}</span>`
}

function renderBlock(block: Block): string {
  const blank = block.blankBefore ? `<div class="blank-line"></div>\n` : ""
  const cls = block.untranslated ? `${block.cls} untranslated` : block.cls
  return `${blank}<p class="${cls}">${block.html}</p>`
}

/** One cell's blocks: its first line carries the verse number, each poetry
 *  line stands on its own, and consecutive prose lines stay one block. */
function cellBlocks(entry: Entry, notes: NoteCollector, flow: boolean): Block[] {
  const blocks: Block[] = []
  entry.lines.forEach((line, index) => {
    const html = (index === 0 ? verseNumberHtml(entry) : "") + lineInlineHtml(line, notes)
    const cls = lineClass(entry, line, flow)
    const last = blocks[blocks.length - 1]
    // Prose lines inside one cell stay one block, broken by <br> — the
    // AQU-2182 behavior for a translation typed across several lines.
    if (last && line.indent === 0 && !line.blankBefore && last.cls === cls) {
      last.html += `<br>\n${html}`
      return
    }
    blocks.push({
      cls,
      html,
      untranslated: entry.untranslated,
      blankBefore: line.blankBefore,
      // Only the cell's first line can continue the paragraph above: a later
      // line of the same cell started after a break of its own.
      continues: flow && index === 0 && line.indent === 0 && !entry.paragraphStart,
    })
  })
  return blocks
}

/**
 * The class of one rendered line. A break marker's own level always wins, so
 * a `\q2` line inside a `\p` paragraph is still indented two levels.
 *
 * Every un-indented line of one cell shares the cell's own class, which is
 * what keeps a translation typed across several lines one block broken by
 * `<br>` — AQU-2182's behavior, and the reason a `\p` inside a verse does not
 * split the verse in two on the page.
 */
function lineClass(entry: Entry, line: CellLine, flow: boolean): string {
  if (line.indent > 0) return blockClass(undefined, line.indent)
  if (entry.paragraphMarker) return blockClass(entry.paragraphMarker, 0)
  if (!flow) return entry.kind === "verse" ? "verse" : "text"
  return "para"
}

function verseNumberHtml(entry: Entry): string {
  return entry.verse ? `<sup class="verse-number">${escapeHtml(entry.verse)}</sup> ` : ""
}

/** Marker → element + class, so section headings, parallel-passage references
 *  and psalm titles each read as their own thing on the page. */
function headingHtml(entry: Entry, notes: NoteCollector): string {
  const mark = entry.untranslated ? " untranslated" : ""
  const html = entry.lines.map((line) => lineInlineHtml(line, notes)).join("<br>\n")
  const base = (entry.headingMarker ?? "s").replace(/\d+$/, "")
  switch (base) {
    case "ms":
      return `<h2 class="major-heading${mark}">${html}</h2>`
    case "r":
    case "mr":
    case "sr":
      return `<p class="parallel-ref${mark}">${html}</p>`
    case "d":
      return `<p class="psalm-title${mark}">${html}</p>`
    case "sp":
      return `<p class="speaker${mark}">${html}</p>`
    case "is":
    case "iot":
    case "imt":
      return `<h3 class="intro-heading${mark}">${html}</h3>`
    default:
      return `<h3 class="section-heading${mark}">${html}</h3>`
  }
}

/**
 * The USFM marker of a heading, read back from the synthetic reference
 * `parseUsfmLossless` gave it — `"PSA 1:s1:1"` → `"s1"`, `"PSA:mt1:1"` →
 * `"mt1"`. A verse reference (`"PSA 1:1"`, `"PSA 1:1-3"`) and a timecode have
 * the wrong shape and read as null, so nothing else is mistaken for a heading
 * marker.
 */
function headingMarkerFromRef(group: string): string | null {
  const parts = group.split(":")
  if (parts.length !== 3) return null
  if (!/^\d+$/.test(parts[2])) return null
  return /^[a-z]+\d*$/.test(parts[1]) ? parts[1] : null
}

/** Book name / title / intro cells above the first chapter. */
function frontMatterHtml(entry: Entry): string {
  const mark = entry.untranslated ? " untranslated" : ""
  const html = entry.lines.map((line) => lineInlineHtml(line)).join("<br>\n")
  return entry.kind === "heading" ? `<h2 class="${mark.trim()}">${html}</h2>` : `<p class="${`text${mark}`}">${html}</p>`
}

function chapterFor(label: string): Chapter {
  const ref = parseScriptureReference(label)
  const id = `ch-${label.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "")}`
  return ref
    ? { id, title: `${ref.bookName} ${ref.chapter}`, indexLabel: ref.chapter, entries: [] }
    : { id, title: label, indexLabel: label, entries: [] }
}

/** The book's name from the first readable reference, else the file's stem. */
function pageTitle(cells: readonly HtmlExportCell[], fileName: string | null | undefined): string {
  for (const cell of cells) {
    const ref = parseScriptureReference(cell.group)
    if (ref) return ref.bookName
  }
  const stem = (fileName ?? "").replace(/\.[^.]+$/, "").trim()
  return stem || "Export"
}

function footerHtml(opts: HtmlExportOptions, untranslated: number): string {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10)
  const mode = opts.validatedOnly
    ? "Target translations, validated only — lines not yet validated are left out."
    : untranslated > 0
      ? `Target translations, current text — ${untranslated} untranslated ${untranslated === 1 ? "line shows" : "lines show"} the source text and ${untranslated === 1 ? "is" : "are"} marked.`
      : "Target translations, current text."
  return (
    `<footer class="metadata">\n<p>Exported from Aquilla on ${date}.</p>\n<p>${mode}</p>\n</footer>`
  )
}

/** A primary language subtag with optional subtags, and not the "undetermined" tag. */
const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

function isLanguageTag(value: string | null | undefined): value is string {
  return !!value && value.toLowerCase() !== "und" && LANGUAGE_TAG_RE.test(value)
}

// Serif reading page; follows the reader's light/dark setting; the index and
// footer are navigation chrome and stay off paper. Poetry indents and the
// chapter's notes are content and DO print (AQU-2184).
const CSS = `:root{--text:#1f2328;--bg:#ffffff;--muted:#6b7280;--rule:#d0d7de;--heading:#24292f;--link:#0969da;--panel:#f6f8fa;--accent:#8b2f2f}
@media (prefers-color-scheme:dark){:root{--text:#e6edf3;--bg:#0d1117;--muted:#9da7b3;--rule:#30363d;--heading:#e6edf3;--link:#58a6ff;--panel:#161b22;--accent:#f0a0a0}}
html{background:var(--bg)}
body{margin:0;color:var(--text);background:var(--bg);font-family:"Noto Serif",Georgia,"Times New Roman",serif;font-size:1.0625rem;line-height:1.7}
main{max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
.book-title{margin:0 0 1.5rem;text-align:center;font-size:2.25rem;line-height:1.2;color:var(--heading)}
.front-matter{margin:0 0 1.5rem;text-align:center;color:var(--muted)}
.front-matter h2{margin:.25rem 0;font-size:1.125rem;font-weight:600;color:var(--heading)}
.front-matter p{margin:.25rem 0}
.chapter-index{margin:0 0 2.5rem;padding:1rem;border:1px solid var(--rule);border-radius:.5rem;background:var(--panel)}
.chapter-index h2{margin:0 0 .5rem;font-family:system-ui,sans-serif;font-size:.8125rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.chapter-index ol{display:flex;flex-wrap:wrap;gap:.375rem;margin:0;padding:0;list-style:none}
.chapter-index a{display:inline-block;min-width:2.25rem;padding:.25rem .5rem;border:1px solid var(--rule);border-radius:.375rem;font-family:system-ui,sans-serif;font-size:.9375rem;text-align:center;color:var(--link);text-decoration:none}
.chapter-index a:hover{background:var(--rule)}
.chapter{margin:0 0 3rem}
.chapter-title{margin:0 0 1rem;text-align:center;font-size:1.5rem;color:var(--heading)}
.section-heading{margin:1.5rem 0 .5rem;font-size:1.0625rem;font-weight:700;color:var(--heading)}
.major-heading{margin:2rem 0 .5rem;font-size:1.25rem;font-weight:700;text-align:center;color:var(--heading)}
.intro-heading{margin:1.5rem 0 .5rem;font-size:1.0625rem;font-weight:700;font-style:italic;color:var(--heading)}
.parallel-ref{margin:0 0 .75rem;font-size:.9375rem;font-style:italic;color:var(--muted)}
.psalm-title{margin:.25rem 0 .75rem;font-style:italic;color:var(--muted)}
.speaker{margin:.75rem 0 .25rem;font-style:italic;font-weight:600}
.verse,.text,.para{margin:0 0 .75rem}
.para-flush{text-indent:0}
.para-indent-1{padding-left:1.25rem}
.para-indent-2{padding-left:2.5rem}
.para-indent-3{padding-left:3.75rem}
.para-indent-4{padding-left:5rem}
.para-centered{text-align:center}
.para-right{text-align:right}
.list{margin:0 0 .25rem}
.list-1{padding-left:1.25rem}
.list-2{padding-left:2.5rem}
.list-3{padding-left:3.75rem}
.list-4{padding-left:5rem}
.poetry{margin:0;text-indent:0}
.poetry-1{padding-left:1.25rem}
.poetry-2{padding-left:2.5rem}
.poetry-3{padding-left:3.75rem}
.poetry-4{padding-left:5rem}
.poetry-centered{text-align:center}
.poetry-right{text-align:right}
.blank-line{height:.9rem}
.verse-number{margin-right:.3em;font-size:.7em;font-weight:700;line-height:0;vertical-align:super;color:var(--muted)}
.small-caps{font-variant-caps:small-caps}
.wj{color:var(--accent)}
.note-marker{font-size:.7em;line-height:0;vertical-align:super}
.note-marker a{color:var(--link);text-decoration:none}
.notes{margin:1.5rem 0 0;padding-top:.75rem;border-top:1px solid var(--rule);font-size:.9375rem}
.notes-title{margin:0 0 .5rem;font-family:system-ui,sans-serif;font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.notes ul{margin:0;padding:0;list-style:none}
.notes li{margin:0 0 .375rem;text-indent:-1.25rem;padding-left:1.25rem}
.note-back{margin-right:.4em;font-weight:700;color:var(--link);text-decoration:none}
.note-ref{font-weight:600;color:var(--muted)}
.note.xref .note-text{font-style:italic}
.untranslated{color:var(--muted);font-style:italic}
.untranslated .translated{color:var(--text);font-style:normal}
.metadata{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);font-family:system-ui,sans-serif;font-size:.8125rem;color:var(--muted)}
.metadata p{margin:.25rem 0}
@media print{@page{margin:2cm}main{max-width:none;padding:0}.chapter-index,.metadata{display:none}.chapter-title,.section-heading,.major-heading{break-after:avoid}.verse,.para,.poetry{break-inside:avoid}.notes{break-inside:avoid;break-before:avoid}.note-marker a,.note-back{color:inherit}}`
