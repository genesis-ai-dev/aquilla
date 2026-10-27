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
// Inline USFM markers never reach the page raw: the display segmenter the
// editor renders with strips the marker tokens, drops note bodies and keeps
// the enclosed words; a break marker inside a verse (\p, \q1 …) becomes a line
// break. Paragraph flow, poetry indents, footnotes and character styles are
// AQU-2184. Every piece of cell text is HTML-escaped — a translation that
// reads `<script>` shows those characters and runs nothing.
//
// AQU-2183 bundles one of these pages per book into a project zip beside an
// index. The page shell, the footer and the "what would this render" count are
// exported for that orchestrator (`html-project.ts`) so the zip's pages and its
// index.html are the same document, built once here rather than twice.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { chapterLabelForCell } from "@/lib/export/chapter-scope"
import { hasUsfmMarkers, usfmDisplayText } from "@/lib/parsers/usfm-display"
import { parseScriptureReference } from "@/lib/scripture-reference"

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
  /** A link back to the project index at the top of the page. Set only by the
   *  whole-project zip (AQU-2183) — a single-book export is one file with no
   *  index to return to, so it must not grow a dead link. */
  backLink?: HtmlBackLink | null
}

/** The "back to the index" link a zip's book page carries (AQU-2183). */
export interface HtmlBackLink {
  /** Relative href inside the zip — `index.html`. */
  href: string
  /** The visible text. */
  label: string
}

/** The only fields the page reads; `CellData` satisfies it. */
export type HtmlExportCell = Pick<CellData, "translated" | "group" | "type"> &
  Parameters<typeof effectiveSourceText>[0]

export function exportHtml(cells: readonly HtmlExportCell[], opts: HtmlExportOptions = {}): Blob {
  return new Blob([buildHtmlPage(cells, opts)], { type: "text/html;charset=utf-8" })
}

interface Line {
  kind: "verse" | "heading" | "text"
  /** Verse number, or range ("1-2"), when the cell is a verse with a readable ref. */
  verse: string | null
  html: string
  untranslated: boolean
}

interface Chapter {
  id: string
  /** "Genesis 1", or the bare label for a chapter that is not a scripture ref. */
  title: string
  /** "1" in the index, or the bare label. */
  indexLabel: string
  lines: Line[]
}

/** The page as a string — `exportHtml` wraps it in a Blob. */
export function buildHtmlPage(cells: readonly HtmlExportCell[], opts: HtmlExportOptions = {}): string {
  const leading: Line[] = []
  const chapters: Chapter[] = []
  const byLabel = new Map<string, Chapter>()
  // Lines with no chapter of their own — front matter, an inserted cell with
  // no reference, a cell whose ref cannot be read — wait for the next
  // referenced cell and go where IT goes: a "Chapter 2" line someone inserted
  // above 2:1 introduces chapter 2, it does not close chapter 1. Before the
  // first chapter they are the front matter; after the last cell they stay
  // with the last chapter.
  let pending: Line[] = []
  let untranslated = 0

  for (const cell of cells) {
    const line = lineFor(cell)
    if (!line) continue
    if (line.untranslated) untranslated++
    const label = chapterLabelForCell(cell)
    if (!label) {
      pending.push(line)
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
    // Lines that waited ahead of this cell belong with it: inside the chapter
    // when it continues one, at the top of the chapter when it opens one.
    chapter.lines.push(...pending, line)
    pending = []
  }
  if (chapters.length === 0) leading.push(...pending)
  else chapters[chapters.length - 1].lines.push(...pending)

  const title = pageTitle(cells, opts.fileName)
  const parts: string[] = []
  if (opts.backLink) parts.push(backLinkHtml(opts.backLink))
  parts.push(`<h1 class="book-title">${escapeHtml(title)}</h1>`)
  if (chapters.length === 0) {
    // No chapters at all: the lines ARE the document, not front matter.
    parts.push(`<section class="chapter">\n${leading.map(lineHtml).join("\n")}\n</section>`)
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
          c.lines.map(lineHtml).join("\n") +
          `\n</section>`,
      )
    }
  }
  parts.push(htmlExportFooter(opts, untranslated))

  return htmlPageShell({ title, lang: opts.lang, body: parts.join("\n") })
}

/**
 * The document around a page's body: doctype, head, the inline CSS, `<main>`.
 * Shared so a zip's index.html is the same page as the books beside it
 * (AQU-2183) — same stylesheet, same shell — rather than a second lookalike.
 */
export function htmlPageShell(opts: { title: string; lang?: string | null; body: string }): string {
  const lang = isLanguageTag(opts.lang) ? ` lang="${escapeHtml(opts.lang)}"` : ""
  return (
    `<!DOCTYPE html>\n<html${lang}>\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(opts.title)}</title>\n<style>\n${CSS}\n</style>\n</head>\n<body>\n<main>\n` +
    opts.body +
    `\n</main>\n</body>\n</html>\n`
  )
}

function backLinkHtml(link: HtmlBackLink): string {
  return `<nav class="back-link"><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></nav>`
}

/** What `buildHtmlPage` would put on the page, without building it.
 *
 *  The zip needs both numbers before it writes anything: a book with no lines
 *  gets no page at all (it is listed in the index as having nothing exported),
 *  and the index's footer counts the untranslated lines across every book. Both
 *  read through `lineFor`, so "this cell renders nothing" stays one rule — a
 *  blank translation with a blank source is absent from the page AND from the
 *  count, and cannot disagree between them. */
export function summarizeHtmlCells(cells: readonly HtmlExportCell[]): { lines: number; untranslated: number } {
  let lines = 0
  let untranslated = 0
  for (const cell of cells) {
    const line = lineFor(cell)
    if (!line) continue
    lines++
    if (line.untranslated) untranslated++
  }
  return { lines, untranslated }
}

function lineFor(cell: HtmlExportCell): Line | null {
  const translated = cell.translated.trim()
  const untranslated = translated === ""
  const raw = untranslated ? effectiveSourceText(cell).trim() : translated
  if (!raw) return null
  const kind: Line["kind"] = cell.type === "verse" ? "verse" : cell.type === "heading" ? "heading" : "text"
  const verse = kind === "verse" ? (parseScriptureReference(cell.group)?.verse ?? null) : null
  return { kind, verse, html: renderText(raw), untranslated }
}

/** Marker-free, escaped text; intra-cell breaks (\p, \q1 …) as `<br>`. */
function renderText(raw: string): string {
  // `~` is USFM's no-break space; only rewritten in text that is USFM at all,
  // so a plain translation containing a tilde is never touched.
  const text = hasUsfmMarkers(raw) ? usfmDisplayText(raw).replace(/~/g, " ") : raw
  return text
    .split("\n")
    .map((s) => escapeHtml(s.trim()))
    .filter((s) => s !== "")
    .join("<br>\n")
}

function lineHtml(line: Line): string {
  const mark = line.untranslated ? " untranslated" : ""
  if (line.kind === "heading") return `<h3 class="section-heading${mark}">${line.html}</h3>`
  if (line.kind === "verse") {
    const number = line.verse ? `<sup class="verse-number">${escapeHtml(line.verse)}</sup> ` : ""
    return `<p class="verse${mark}">${number}${line.html}</p>`
  }
  return `<p class="text${mark}">${line.html}</p>`
}

/** Book name / title / intro cells above the first chapter. */
function frontMatterHtml(line: Line): string {
  const mark = line.untranslated ? " untranslated" : ""
  return line.kind === "heading" ? `<h2 class="${mark.trim()}">${line.html}</h2>` : `<p class="${`text${mark}`}">${line.html}</p>`
}

function chapterFor(label: string): Chapter {
  const ref = parseScriptureReference(label)
  const id = `ch-${label.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "")}`
  return ref
    ? { id, title: `${ref.bookName} ${ref.chapter}`, indexLabel: ref.chapter, lines: [] }
    : { id, title: label, indexLabel: label, lines: [] }
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

export function htmlExportFooter(opts: HtmlExportOptions, untranslated: number): string {
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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Serif reading page; follows the reader's light/dark setting; the index and
// footer are navigation chrome and stay off paper.
const CSS = `:root{--text:#1f2328;--bg:#ffffff;--muted:#6b7280;--rule:#d0d7de;--heading:#24292f;--link:#0969da;--panel:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--text:#e6edf3;--bg:#0d1117;--muted:#9da7b3;--rule:#30363d;--heading:#e6edf3;--link:#58a6ff;--panel:#161b22}}
html{background:var(--bg)}
body{margin:0;color:var(--text);background:var(--bg);font-family:"Noto Serif",Georgia,"Times New Roman",serif;font-size:1.0625rem;line-height:1.7}
main{max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
.book-title{margin:0 0 1.5rem;text-align:center;font-size:2.25rem;line-height:1.2;color:var(--heading)}
.front-matter{margin:0 0 1.5rem;text-align:center;color:var(--muted)}
.front-matter h2{margin:.25rem 0;font-size:1.125rem;font-weight:600;color:var(--heading)}
.front-matter p{margin:.25rem 0}
.back-link{margin:0 0 1.5rem;font-family:system-ui,sans-serif;font-size:.875rem}
.back-link a{color:var(--link);text-decoration:none}
.back-link a:hover{text-decoration:underline}
.book-list{margin:0;padding:0;list-style:none}
.book-list li{padding:.5rem 0;border-bottom:1px solid var(--rule);font-family:system-ui,sans-serif}
.book-list a{color:var(--link);text-decoration:none}
.book-list a:hover{text-decoration:underline}
.book-list .empty{color:var(--muted)}
.book-list .empty-note{margin-left:.5rem;font-size:.8125rem}
.book-list .file-note{color:var(--muted);font-size:.8125rem}
.chapter-index{margin:0 0 2.5rem;padding:1rem;border:1px solid var(--rule);border-radius:.5rem;background:var(--panel)}
.chapter-index h2{margin:0 0 .5rem;font-family:system-ui,sans-serif;font-size:.8125rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.chapter-index ol{display:flex;flex-wrap:wrap;gap:.375rem;margin:0;padding:0;list-style:none}
.chapter-index a{display:inline-block;min-width:2.25rem;padding:.25rem .5rem;border:1px solid var(--rule);border-radius:.375rem;font-family:system-ui,sans-serif;font-size:.9375rem;text-align:center;color:var(--link);text-decoration:none}
.chapter-index a:hover{background:var(--rule)}
.chapter{margin:0 0 3rem}
.chapter-title{margin:0 0 1rem;text-align:center;font-size:1.5rem;color:var(--heading)}
.section-heading{margin:1.5rem 0 .5rem;font-size:1.0625rem;font-weight:700;color:var(--heading)}
.verse,.text{margin:0 0 .75rem}
.verse-number{margin-right:.3em;font-size:.7em;font-weight:700;line-height:0;vertical-align:super;color:var(--muted)}
.untranslated{color:var(--muted);font-style:italic}
.metadata{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);font-family:system-ui,sans-serif;font-size:.8125rem;color:var(--muted)}
.metadata p{margin:.25rem 0}
@media print{@page{margin:2cm}main{max-width:none;padding:0}.chapter-index,.metadata,.back-link{display:none}.chapter-title,.section-heading{break-after:avoid}.verse{break-inside:avoid}}`
