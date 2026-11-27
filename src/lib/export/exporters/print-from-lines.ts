// AQU-2680 (question 54, Sam's decision Nov 19): the page the PDF export
// prints. There is no converter on a server: the browser prints this page and
// the person picks "Save as PDF" in its print window, so the browser lays out
// and shapes every script (Arabic, Hebrew, Devanagari…) with its own fonts.
//
// It is laid out from the same structure the new Word document is written
// from (`linesToParagraphs`), so the two agree: headings, paragraphs, lists
// numbered alike (`numberLists`), whole-paragraph bold and italic,
// right-to-left paragraphs, the target language, and the page size and
// margins the import recorded (`@page`), else A4. Inline text and notes go
// through the HTML page export's own pieces (`lineInlineHtml`, the note
// collector, `escapeHtml`), so nothing in a translation runs as markup.
// Browsers have no page footnotes when printing, so the notes are listed at
// the end, numbered, as the HTML page lists them.

import type { CellData } from "@/hooks/useCells"
import { detectStrongTextDirection } from "@/lib/text-direction"
import { createNoteCollector, escapeHtml, lineInlineHtml } from "./html-blocks"
import { isLanguageTag } from "./html"
import { BULLETS, linesToParagraphs, listNumberText, numberLists, pageMarginPoints, pageSizeOf, type LinesParagraph } from "./docx-from-lines"

export interface PrintPageOptions {
  /** The page's title; browsers name the saved PDF after it. */
  title: string
  /** The language the page is written in (the export's target language). */
  lang?: string
}

const HEADING_TAG: Record<string, string> = { Title: "h1", Heading1: "h1", Heading2: "h2", Heading3: "h3", Heading4: "h4", Heading5: "h5", Heading6: "h6" }

// The Word document's sizes (styles.xml), in points.
const CSS = `html{background:#fff}
body{margin:0;color:#000;background:#fff;font-family:"Noto Serif","Times New Roman",serif;font-size:11pt;line-height:1.3}
h1,h2,h3,h4,h5,h6{margin:12pt 0 6pt;font-weight:700;line-height:1.2;break-after:avoid}
h1.title{font-size:28pt}h1{font-size:16pt}h2{font-size:14pt}h3{font-size:13pt}h4{font-size:12pt}h5,h6{font-size:11pt}
p{margin:0 0 8pt;orphans:2;widows:2}
.b{font-weight:700}.i{font-style:italic}
.li{position:relative;margin-bottom:2pt}
.li-label{position:absolute;inset-inline-end:100%;margin-inline-end:6pt;white-space:nowrap}
${Array.from({ length: 9 }, (_, l) => `.li-${l}{margin-inline-start:${36 * (l + 1)}pt}`).join("")}
.small-caps{font-variant-caps:small-caps}
.note-marker{font-size:.7em;line-height:0;vertical-align:super}
.note-marker a,.note-back{color:inherit;text-decoration:none}
.notes{margin-top:18pt;padding-top:6pt;border-top:.5pt solid #000;font-size:10pt}
.notes-title{margin:0 0 4pt;font-size:10pt}
.notes ul{margin:0;padding:0;list-style:none}
.notes li{margin:0 0 3pt}
.note-back{margin-inline-end:.4em;font-weight:700}`

/** The `@page` rule: the recorded page size and the Word file's margins. */
function pageRule(cells: readonly CellData[]): string {
  const size = pageSizeOf(cells)
  const margin = Math.round(pageMarginPoints(size) * 100) / 100
  return `@page{size:${size ? `${size.width}pt ${size.height}pt` : "A4"};margin:${margin}pt}`
}

function paragraphHtml(p: LinesParagraph, number: string | null, notes: ReturnType<typeof createNoteCollector>): string {
  const plain = p.lines.flat().map((r) => r.text).join("")
  const dir = detectStrongTextDirection(plain) === "rtl" ? ` dir="rtl"` : ""
  const inline = p.lines.map((runs) => lineInlineHtml({ indent: 0, blankBefore: false, runs }, notes)).join("<br>")
  const classes = [...(p.list ? ["li", `li-${p.list.level}`] : []), ...(p.bold ? ["b"] : []), ...(p.italic ? ["i"] : [])]
  const cls = classes.length ? ` class="${classes.join(" ")}"` : ""
  if (p.style) {
    const tag = HEADING_TAG[p.style] ?? "h1"
    const heading = p.style === "Title" ? ["title", ...classes] : classes
    return `<${tag}${heading.length ? ` class="${heading.join(" ")}"` : ""}${dir}>${inline}</${tag}>`
  }
  const label = number !== null ? `<span class="li-label" aria-hidden="true">${escapeHtml(number)}</span>` : ""
  return `<p${cls}${dir}>${label}${inline}</p>`
}

/** The print page for these lines, as a complete HTML document. */
export function buildPrintPage(cells: readonly CellData[], options: PrintPageOptions): string {
  const paragraphs = linesToParagraphs(cells)
  const { numbers } = numberLists(paragraphs)
  const notes = createNoteCollector("n")
  const body = paragraphs.map((p, k) => {
    const n = numbers[k]
    const number = n ? listNumberText(n) : p.list?.kind === "bullet" ? BULLETS[p.list.level % 3] : null
    return paragraphHtml(p, number, notes)
  })
  const lang = isLanguageTag(options.lang) ? ` lang="${escapeHtml(options.lang)}"` : ""
  return `<!DOCTYPE html>\n<html${lang}>\n<head>\n<meta charset="utf-8">\n` +
    `<title>${escapeHtml(options.title)}</title>\n<style>\n${pageRule(cells)}\n${CSS}\n</style>\n</head>\n<body>\n` +
    `${body.join("\n")}\n${notes.listHtml()}\n</body>\n</html>\n`
}
