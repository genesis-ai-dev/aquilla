// Shared TSV helpers for the notes/questions resource routes (spec §4).
//
// The unfoldingWord TSV resources (tn/tq/sn/sq) share a column model:
//   Reference | ID | Tags | SupportReference | Quote | Occurrence | <prose…>
// where <prose…> is `Note` for notes and `Question`(+`Response`) for questions.
//
// The cell-id seed is `${repo}|${book}|${rowID}` using the TSV `ID` column,
// which unfoldingWord guarantees stable per row (spec §4/§5) — so a re-import
// derives the same id even when a note's prose changes, making the delta a
// commit (not churn). We parse columns directly here (header-driven) rather than
// reusing translation-notes.ts, because the spec requires column-precise
// metadata (SupportReference/Quote/Occurrence/Tags) and prose isolation that the
// looser TN parser does not preserve.

/** One parsed TSV data row, header-resolved. */
export interface TsvRow {
  /** The TSV `ID` column value (stable per row). */
  rowId: string
  /** Raw `Reference` cell, e.g. "1:1" or "front:intro". */
  reference: string
  /** Untranslated columns to carry in `cell.metadata` (only present keys). */
  metadata: Record<string, string>
  /** Named prose columns keyed by lowercased header (e.g. note/question/response). */
  prose: Record<string, string>
}

const META_HEADERS = new Set(["tags", "supportreference", "quote", "occurrence", "origquote"])
/** Header → canonical metadata key for the carried columns. */
const META_KEY: Record<string, string> = {
  tags: "tags",
  supportreference: "supportReference",
  quote: "quote",
  origquote: "quote",
  occurrence: "occurrence",
}

export interface ParsedTsv {
  /** Header cells, lowercased+trimmed, in file order. */
  header: string[]
  rows: TsvRow[]
  /** Rows skipped because they had no usable `ID`. */
  skippedCount: number
}

/**
 * Parse a unfoldingWord-style TSV into header-resolved rows. Robust to a leading
 * BOM and CRLF/LF line endings. Structural (`ID`/`Reference`/`Tags`/
 * `SupportReference`/`Quote`/`Occurrence`) columns are separated from prose
 * columns; the caller decides which prose column(s) are translatable.
 *
 * A row with a blank `ID` is skipped (it has no stable identity — spec §5).
 */
export function parseResourceTsv(tsvText: string): ParsedTsv {
  let text = tsvText
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const lines = text.split(/\r?\n/)
  const headerLine = lines.find((l) => l.trim().length > 0)
  if (headerLine === undefined) {
    return { header: [], rows: [], skippedCount: 0 }
  }
  const header = headerLine.split("\t").map((h) => h.trim().toLowerCase())
  const idx = (name: string): number => header.indexOf(name)

  const iId = idx("id")
  const iReference = ((): number => {
    const r = idx("reference")
    return r !== -1 ? r : idx("ref")
  })()

  const rows: TsvRow[] = []
  let skippedCount = 0

  let seenHeader = false
  for (const line of lines) {
    if (line.trim().length === 0) continue
    if (!seenHeader) {
      seenHeader = true // the first non-empty line is the header
      continue
    }
    const cols = line.split("\t")

    const rowId = iId !== -1 ? (cols[iId] ?? "").trim() : ""
    if (!rowId) {
      skippedCount++
      continue
    }

    const reference = iReference !== -1 ? (cols[iReference] ?? "").trim() : ""

    const metadata: Record<string, string> = {}
    const prose: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) {
      const key = header[c]
      const val = (cols[c] ?? "").trim()
      if (key === "id" || key === "reference" || key === "ref") continue
      if (META_HEADERS.has(key)) {
        if (val) metadata[META_KEY[key] ?? key] = val
      } else {
        // Prose column (note / question / response / anything else). Keep even
        // when empty so the caller can detect presence of the column.
        prose[key] = val
      }
    }

    rows.push({ rowId, reference, metadata, prose })
  }

  return { header, rows, skippedCount }
}

const BOOK_ID_RE = /\b([1-3]?[A-Za-z]{2,3})\b/

/**
 * Derive a book code for the cell-id seed. Prefers a `BOOK` token embedded in
 * the `Reference` (rare — unfoldingWord references are usually chapter:verse
 * only), otherwise falls back to the book code in the file name
 * (`tn_TIT.tsv`, `57-tit.tsv`, `en_tq_57-TIT.tsv`, `tq_OBS.tsv` → "TIT"/"OBS").
 * Always UPPERCASED so the seed is stable across filename casing.
 */
export function bookCodeFromTsv(path: string, sampleReference: string): string {
  // A reference like "GEN 1:1" carries the book; "1:1" does not.
  if (sampleReference.includes(" ")) {
    const first = sampleReference.split(/\s+/)[0]
    if (first && /^[1-3]?[A-Za-z]{2,4}$/.test(first)) return first.toUpperCase()
  }
  const base = (path.split("/").pop() ?? path).replace(/\.tsv$/i, "")
  // Take the last underscore/hyphen-delimited token that looks like a book id.
  const tokens = base.split(/[_-]/).filter(Boolean)
  for (let t = tokens.length - 1; t >= 0; t--) {
    const m = tokens[t].match(BOOK_ID_RE)
    if (m && !/^\d+$/.test(tokens[t])) return m[1].toUpperCase()
  }
  return base.toUpperCase()
}

/** Build the "BOOK CH:V" canonical ref from a book code + TSV `Reference` cell. */
export function canonicalRefFromTsv(book: string, reference: string): string {
  if (!reference) return book
  // A reference that already includes a space is treated as a full ref.
  return reference.includes(" ") ? reference : `${book} ${reference}`
}

// ---------------------------------------------------------------------------
// Prose fidelity — TSV escape unfolding + markdown → cell HTML.
//
// unfoldingWord TSV cells cannot contain a real newline/tab, so prose columns
// embed them as the LITERAL two-character sequences `\n` / `\t` (and `\\` for a
// literal backslash). Without unescaping, imported cells display raw "\n"
// pairs. Prose is also markdown; we render it to `cell.valueHtml` so the editor
// shows headings/bold/lists instead of `#`/`**` syntax. The repo's existing
// markdown→HTML helpers (src/lib/parsers/markdown.ts markdownInlineToHtml) are
// module-private, so the same inline conventions (<b>/<i>/<s>/<code>) are
// mirrored here with HTML-escaping added (TSV prose is untrusted text).
// ---------------------------------------------------------------------------

/**
 * Unfold the TSV escapes in a prose cell: literal `\n` → newline, `\t` → tab,
 * `\\` → backslash. One left-to-right pass, so `\\n` correctly yields a
 * backslash followed by the letter n (the `\\` is consumed first).
 */
export function unescapeTsvProse(raw: string): string {
  return raw.replace(/\\\\|\\n|\\t/g, (m) => (m === "\\\\" ? "\\" : m === "\\n" ? "\n" : "\t"))
}

// `[[rc://STAR/ta/man/translate/figs-metaphor]]`-style unfoldingWord resource
// links (the wildcard segment is a literal asterisk in the source files).
const RC_WIKI_LINK_RE = /\[\[(rc:\/\/[^\]]+)\]\]/g
/** Any markdown link `[text](target)` (target has no spaces/parens). */
const MD_LINK_RE = /\[([^\]]*)\]\(([^()\s]+)\)/g

/** Human-readable tail of an rc:// URI or relative path: "…/figs-metaphor" → "figs-metaphor". */
function readableLinkText(target: string): string {
  const trimmed = target.replace(/\.md$/i, "").replace(/\/+$/, "")
  const seg = trimmed.split("/").filter(Boolean).pop()
  return seg ?? target
}

/**
 * Replace unfoldingWord link forms that resolve nowhere in Aquilla with their
 * readable text, BEFORE markdown rendering — so no broken `<a href>` is
 * emitted. `[[rc://…]]` → last path segment ("figs-metaphor"); relative /
 * rc:// markdown links → the link text (or the target's tail when the text is
 * empty). Absolute http(s) links pass through untouched.
 */
export function stripUnresolvableLinks(md: string): string {
  let out = md.replace(RC_WIKI_LINK_RE, (_m, uri: string) => readableLinkText(uri))
  out = out.replace(MD_LINK_RE, (m: string, text: string, target: string) => {
    if (/^https?:\/\//i.test(target)) return m
    return text || readableLinkText(target)
  })
  return out
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Inline markdown → HTML on ONE escaped text run. http(s) links become real
 *  anchors (tokenized first so emphasis rules cannot mangle underscores in
 *  the href); bold/italic/strike/code mirror parsers/markdown.ts. */
function inlineHtml(text: string): string {
  let html = escapeHtml(text)
  const anchors: string[] = []
  html = html.replace(
    /\[([^\]]+)\]\((https?:[^()\s]+)\)/gi,
    (_m, label: string, href: string) => {
      anchors.push(`<a href="${href}">${label}</a>`)
      return `\uE000${anchors.length - 1}\uE000`
    },
  )
  html = html
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
  return html.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => anchors[Number(i)])
}

/**
 * Render TSV prose markdown (already unescaped) to cell HTML. Block model
 * mirrors parsers/markdown.ts: `#`-headings, `-`/`*`/`+` and `1.` lists,
 * `>` blockquotes, blank-line-separated paragraphs. Unresolvable
 * unfoldingWord links are stripped to readable text first.
 */
export function tsvMarkdownToHtml(markdown: string): string {
  const md = stripUnresolvableLinks(markdown)
  const out: string[] = []
  let para: string[] = []
  let list: { kind: "ul" | "ol"; items: string[] } | null = null

  const flushPara = (): void => {
    if (para.length === 0) return
    out.push(`<p>${inlineHtml(para.join(" "))}</p>`)
    para = []
  }
  const flushList = (): void => {
    if (list === null) return
    out.push(`<${list.kind}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.kind}>`)
    list = null
  }

  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim()
    if (line === "") {
      flushPara()
      flushList()
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.+)/)
    if (h) {
      flushPara()
      flushList()
      out.push(`<h${h[1].length}>${inlineHtml(h[2])}</h${h[1].length}>`)
      continue
    }
    const ul = line.match(/^[-*+]\s+(.+)/)
    if (ul) {
      flushPara()
      if (list?.kind !== "ul") {
        flushList()
        list = { kind: "ul", items: [] }
      }
      list.items.push(inlineHtml(ul[1]))
      continue
    }
    const ol = line.match(/^\d+\.\s+(.+)/)
    if (ol) {
      flushPara()
      if (list?.kind !== "ol") {
        flushList()
        list = { kind: "ol", items: [] }
      }
      list.items.push(inlineHtml(ol[1]))
      continue
    }
    const quote = line.match(/^>\s*(.*)/)
    if (quote) {
      flushPara()
      flushList()
      out.push(`<blockquote><p>${inlineHtml(quote[1])}</p></blockquote>`)
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return out.join("")
}
