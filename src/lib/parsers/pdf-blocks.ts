// AQU-2551: turn what pdf.js reads off a PDF's pages into paragraphs.
//
// Pure: no pdf.js, no DOM. `pdf.ts` reads each page's positioned text pieces,
// marked-content brackets and structure tree with pdf.js and hands them here.
// The feasibility study (Nov 12) measured this logic on a 58-page Word PDF
// against the Word import of the same document.
//
// Two readers, one per kind of PDF:
//
//  - A TAGGED PDF (one saved from Word, InDesign…) is read by its tags. Each
//    tagged block (P, H1–H6, LI, table cell, caption, TOC line) is one
//    paragraph; headings are typed from their tags. Blocks are placed in the
//    order their text is drawn on the page, which fixes the places where a
//    producer's tag order differs from the printed order. Running headers,
//    footers and page numbers are Artifacts and never reached; list labels
//    (Lbl: bullets and generated numbers) are dropped, as the Word import
//    never sees Word's generated numbers (question 55).
//  - An UNTAGGED PDF is read by its layout: lines from positions, paragraphs
//    from gaps, indents and size changes. Lines in the top or bottom tenth of
//    the page that repeat on three or more pages, and lone page numbers, are
//    dropped; so are dot leaders and leading bullet glyphs. Columns are kept
//    in order. Sam's pick (critique, Nov 12): no headings at all, because
//    guessing them from text size gave 16 false headings in one document.
//
// Then the same text rules for either reader:
//  1. Spacing: a line end or a visible gap between two pieces is one space. A
//     hyphen at a line end joins the word only when the joined word appears
//     unbroken elsewhere in the document ("col-|umns" → "columns", but
//     "non-|commercial" stays). A dash at a line end that is attached to its
//     word ("57–|58") takes no space.
//  2. Page continuation: a paragraph cut by a page (or column) foot
//     mid-sentence continues on the next.
//  Plus: the right-to-left mark repair (pdf.js reverses a right-to-left run
//  as a whole, so each letter's vowel marks land before it; they are put back
//  after their letter), and the Word import's footnote rule: a footnote goes in
//  at its mark, as an inline `\f + \ft …\f*` marker.

/** One positioned text piece, as pdf.js gives it (transform[4], [5], …). */
export interface PdfTextPiece {
  s: string
  x: number
  y: number
  /** transform[1]: non-zero for rotated text. */
  b: number
  w: number
  h: number
  eol: boolean
  dir: string
}

/** A marked-content bracket from `getTextContent({ includeMarkedContent })`. */
export type PdfMarkedContent =
  | { mc: "begin"; id: string | null; tag: string | null }
  | { mc: "end" }

export type PdfPageItem = PdfTextPiece | PdfMarkedContent

/** pdf.js `getStructTree()` node: an element (role, children) or a leaf
 *  (`type: "content"` with the marked-content id it owns). */
export interface PdfStructNode {
  role?: string
  type?: string
  id?: string
  alt?: string
  children?: PdfStructNode[]
}

export interface PdfPageContent {
  /** 1-based page number. */
  n: number
  w: number
  h: number
  items: PdfPageItem[]
  tree: PdfStructNode | null
}

export interface PdfParagraph {
  text: string
  /** "Title", "Heading 1"…"Heading 6", "Heading" for a heading; null otherwise. */
  heading: string | null
  /** The page the paragraph starts on (1-based). */
  page: number
}

export interface PdfReadResult {
  paragraphs: PdfParagraph[]
  /** True when the tagged reader was used. */
  tagged: boolean
}

/** A footnote marker in the Word import's inline form (createUsfmFootnoteMarker). */
export type FootnoteMarker = (text: string) => string

const isPiece = (it: PdfPageItem | NotePart): it is PdfTextPiece => "s" in it
/** A footnote put in at its mark; `eol` is the mark's own line end. */
type NotePart = { note: string; eol?: boolean }
type Part = PdfTextPiece | NotePart

const BLOCK_ROLES = new Set(["P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "Title", "Caption", "TOCI", "LI", "TH", "TD", "BlockQuote", "BibEntry", "Code", "Index"])
const HEADING_ROLE = /^(H[1-6]?|Title)$/
/** A paragraph that ends with one of these ended its sentence. */
const END_PUNCT = /[.!?:;"”’)\]…»]$/
/** Share of a page's text the tags must cover for the tagged reader to be used. */
const MIN_TAG_COVERAGE = 0.8

/** pdf.js puts a right-to-left run's combining marks before their letter. */
function repairRtl(piece: PdfTextPiece): PdfTextPiece {
  if (piece.dir !== "rtl" || !/^\p{Mn}/u.test(piece.s)) return piece
  return { ...piece, s: piece.s.replace(/(\p{Mn}+)(\p{L})/gu, "$2$1") }
}

/** Dot leaders (TOC lines) become one space; every whitespace run one space. */
const clean = (s: string) => s.replace(/\s*\.{5,}\s*/g, " ").replace(/\s+/g, " ").trim()

/** Word's heading numbers ("2.1.1.", "1.1. ", "3.1 ") are printed in a tagged
 *  PDF's heading text, not in a Lbl. Drop them, as the Word import never sees
 *  them (question 55). A bare number with no dot ("1 Corinthians") stays. */
const stripHeadingNumber = (s: string) => s.replace(/^(?:\d+(?:\.\d+)+\.?|\d+\.)(?=\s|\p{L})\s*/u, "")

class TextJoiner {
  private readonly words = new Set<string>()

  constructor(pages: readonly PdfPageContent[]) {
    for (const page of pages) for (const it of page.items) {
      if (!isPiece(it)) continue
      for (const w of it.s.toLowerCase().match(/\p{L}+/gu) ?? []) this.words.add(w)
    }
  }

  /** `left` ends in "letter-": drop the hyphen when the joined word appears
   *  unbroken elsewhere in the document. A soft hyphen always joins. */
  joinHyphen(left: string, right: string): string {
    if (left.endsWith("­")) return left.slice(0, -1) + right
    const a = /(\p{L}+)-$/u.exec(left)
    const b = /^(\p{L}+)/u.exec(right)
    if (a && b && this.words.has((a[1] + b[1]).toLowerCase())) return left.slice(0, -1) + right
    return left + right
  }

  /** Join a run of pieces (and inline notes) into one string. */
  join(parts: readonly Part[]): string {
    let s = ""
    let prev: PdfTextPiece | null = null
    let pendingBreak = false
    for (const it of parts) {
      if (!isPiece(it)) {
        // the note sits right after its word, as the Word import puts it
        s = s.replace(/\s+$/, "") + it.note
        if (it.eol && !/\s$/.test(s)) s += " "
        prev = null
        pendingBreak = false
        continue
      }
      if (it.s) {
        if (pendingBreak) {
          pendingBreak = false
          s = this.joinHyphen(s, it.s).slice(0, -it.s.length || undefined)
        } else if (prev && prev.w > 0 && it.w > 0 && !/\s$/.test(s) && !/^\s/.test(it.s)) {
          // Two pieces on one baseline with a visible gap, in either reading
          // direction, and no space between them: one space.
          const h = Math.max(it.h, prev.h, 1)
          const gap = Math.max(it.x - (prev.x + prev.w), prev.x - (it.x + it.w))
          if (Math.abs(it.y - prev.y) < 0.3 * h && gap > 0.15 * h) s += " "
        }
        s += it.s
        prev = it
      }
      if (it.eol) {
        if (/\p{L}[-­]$/u.test(s)) { pendingBreak = true; continue }
        // A dash attached to its word ("57–") runs on without a space.
        if (/\S[–—]$/u.test(s)) continue
        if (!/\s$/.test(s)) s += " "
      }
    }
    return s
  }
}

// ─── tagged ─────────────────────────────────────────────────────────────────

interface TaggedBlock {
  role: string
  text: string
  page: number
  /** Index of the block's first drawn piece on its page. */
  order: number
}

interface Coverage { tagged: number; untagged: number }

function readTaggedPage(page: PdfPageContent, joiner: TextJoiner, footnote: FootnoteMarker, coverage: Coverage): TaggedBlock[] {
  // marked-content id → its pieces, in drawing order
  const byId = new Map<string, (PdfTextPiece & { order: number })[]>()
  const stack: { id: string | null; tag: string | null }[] = []
  page.items.forEach((it, order) => {
    if (!isPiece(it)) {
      if (it.mc === "begin") stack.push({ id: it.id, tag: it.tag })
      else stack.pop()
      return
    }
    let owner: string | null = null
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].id) { owner = stack[k].id; break }
    if (owner) {
      const list = byId.get(owner) ?? []
      list.push({ ...repairRtl(it), order })
      byId.set(owner, list)
    } else if (!stack.some((e) => e.tag === "Artifact")) {
      coverage.untagged += it.s.trim().length
    }
  })
  const used = new Set<string>()
  const blocks: TaggedBlock[] = []
  let cur: { role: string; parts: Part[] } | null = null

  const contentOf = (node: PdfStructNode): Part[] => {
    const out: Part[] = []
    for (const c of node.children ?? []) {
      if (c.type === "content" && c.id) { out.push(...(byId.get(c.id) ?? [])); used.add(c.id) }
      else if (!c.type) out.push(...contentOf(c))
    }
    return out
  }
  const flush = () => {
    if (!cur) return
    const text = clean(joiner.join(cur.parts))
    const pieces = cur.parts.filter((p): p is PdfTextPiece & { order: number } => isPiece(p) && p.s.trim() !== "")
    if (text && pieces.length) {
      blocks.push({ role: cur.role, text, page: page.n, order: Math.min(...pieces.map((p) => p.order)) })
    }
    cur = null
  }
  // A Note is a footnote only when it looks like one: its text starts with a
  // number and it holds no list, heading or table (Word also wraps linked
  // heading lists in Note; those are read as ordinary content).
  const hasStructure = (n: PdfStructNode): boolean =>
    (n.children ?? []).some((k) => !k.type && (/^(L|LI|H[1-6]?|Table)$/.test(k.role ?? "") || hasStructure(k)))

  const visit = (node: PdfStructNode, inBlock: boolean): void => {
    for (const c of node.children ?? []) {
      if (c.type === "content") {
        if (!c.id) continue
        used.add(c.id)
        const pieces = byId.get(c.id) ?? []
        if (cur) cur.parts.push(...pieces)
        else if (joiner.join(pieces).trim()) cur = { role: "P", parts: [...pieces] }
        continue
      }
      if (c.type) continue // an annotation or object reference
      const role = c.role ?? ""
      if (role === "Figure" || role === "Artifact") { contentOf(c); continue }
      if (role === "Lbl") { contentOf(c); continue }
      if (role === "Note") {
        const noteParts = contentOf(c)
        const raw = joiner.join(noteParts)
        if (hasStructure(c) || !/^\s*\d/.test(raw)) {
          // not a footnote: read what it holds as ordinary content
          visit(c, inBlock)
          continue
        }
        const note = clean(raw).replace(/^\d+\s*/, "")
        if (cur) {
          // drop the reference mark: a digits-only piece, or digits at the end
          // of the piece just before the note; the note takes the mark's line end
          let eol = false
          for (let k = cur.parts.length - 1; k >= 0; k--) {
            const it = cur.parts[k]
            if (!isPiece(it) || !it.s.trim()) continue
            eol = it.eol
            cur.parts[k] = { ...it, eol: false, s: /^\s*\d{1,3}\s*$/.test(it.s) ? "" : it.s.replace(/(\D)\d{1,3}$/, "$1") }
            break
          }
          cur.parts.push({ note: footnote(note), eol })
        } else if (note) {
          const order = Math.min(...noteParts.filter(isPiece).map((p) => (p as PdfTextPiece & { order: number }).order))
          blocks.push({ role: "P", text: note, page: page.n, order })
        }
        continue
      }
      if (BLOCK_ROLES.has(role)) {
        const outer = cur?.role
        flush()
        cur = { role, parts: [] }
        visit(c, true)
        flush()
        if (outer && inBlock) cur = { role: outer, parts: [] }
        continue
      }
      visit(c, inBlock)
    }
  }
  if (page.tree) visit(page.tree, false)
  flush()
  // How much of the page's text the tags reach (dropped labels, figures and
  // artifacts count as reached: the tags placed them).
  for (const [id, pieces] of byId) {
    const chars = pieces.reduce((n, p) => n + p.s.trim().length, 0)
    if (used.has(id)) coverage.tagged += chars
    else coverage.untagged += chars
  }
  // The tags say what a paragraph is; the page's drawing order says where it goes.
  return blocks.sort((a, b) => a.order - b.order)
}

function headingContext(role: string): string | null {
  if (!HEADING_ROLE.test(role)) return null
  if (role === "Title") return "Title"
  return role === "H" ? "Heading" : `Heading ${role.slice(1)}`
}

/** Page continuation: the first body paragraph of a page continues the last
 *  one of the previous page when that one stopped mid-sentence. */
function continueAcrossPages<T extends { text: string; page: number }>(
  pages: readonly T[][],
  isBody: (block: T) => boolean,
  sameKind: (a: T, b: T) => boolean = () => true,
): T[] {
  const out: T[] = []
  for (const blocks of pages) {
    blocks.forEach((b, i) => {
      const prev = out[out.length - 1]
      if (
        i === 0 && prev && isBody(prev) && isBody(b) && b.page === prev.page + 1 && sameKind(prev, b)
        && !END_PUNCT.test(prev.text.replace(/\\f\*$/, "").trim())
      ) {
        out[out.length - 1] = { ...prev, text: clean(`${prev.text} ${b.text}`) }
        return
      }
      out.push({ ...b })
    })
  }
  return out
}

function readTagged(pages: readonly PdfPageContent[], joiner: TextJoiner, footnote: FootnoteMarker): { paragraphs: PdfParagraph[]; coverage: number } {
  const coverage: Coverage = { tagged: 0, untagged: 0 }
  const perPage = pages.map((p) => readTaggedPage(p, joiner, footnote, coverage))
  const joined = continueAcrossPages(perPage, (b) => b.role === "P")
  const paragraphs = joined.map((b): PdfParagraph => {
    const heading = headingContext(b.role)
    const text = heading ? stripHeadingNumber(b.text) : b.text
    return { text, heading, page: b.page }
  }).filter((p) => p.text)
  const total = coverage.tagged + coverage.untagged
  return { paragraphs, coverage: total ? coverage.tagged / total : 0 }
}

// ─── layout ─────────────────────────────────────────────────────────────────

interface Line {
  y: number
  x: number
  right: number
  h: number
  size: number
  sizeChars: Map<number, number>
  text: string
  prev: (PdfTextPiece & { sup: boolean }) | null
}

// Private-use sentinels around a raised footnote number in a line.
const MARK_OPEN = "\u0001"
const MARK_CLOSE = "\u0002"

function layoutLines(page: PdfPageContent): Line[] {
  const lines: Line[] = []
  let cur: Line | null = null
  for (const raw of page.items) {
    if (!isPiece(raw) || !raw.s) continue
    if (Math.abs(raw.b) > 0.01) continue // rotated text is not reading text
    const it = repairRtl(raw)
    const h = Math.max(it.h, 1)
    // gap to the previous piece, reading left-to-right or right-to-left
    const gap: number = cur?.prev ? Math.max(it.x - (cur.prev.x + cur.prev.w), cur.prev.x - (it.x + it.w)) : 0
    // A new line: the baseline moved, or a wide jump sideways (a table cell,
    // a second column). pdf.js's own end-of-line flags are not trusted, so a
    // raised superscript stays on its line.
    const newLine = !cur
      || Math.abs(it.y - cur.y) > 0.45 * Math.max(h, cur.h)
      || (gap > 3 * h && it.dir !== "rtl" && cur.prev?.dir !== "rtl")
    const sup = !!cur && !newLine && h < 0.85 * cur.h && it.y - cur.y > 0.12 * cur.h
    if (newLine || !cur) {
      cur = { y: it.y, x: it.x, right: it.x + it.w, h, size: 0, sizeChars: new Map(), text: "", prev: null }
      lines.push(cur)
    } else if (!sup && cur.prev && !cur.prev.sup && cur.prev.w > 0 && it.w > 0 && gap > 0.15 * h && !/\s$/.test(cur.text) && !/^\s/.test(it.s)) {
      cur.text += " "
    }
    cur.prev = { ...it, sup }
    cur.x = Math.min(cur.x, it.x)
    cur.h = Math.max(cur.h, h)
    cur.right = Math.max(cur.right, it.x + it.w)
    if (sup && /^\s*\d{1,3}\s*$/.test(it.s)) { cur.text += `${MARK_OPEN}${it.s.trim()}${MARK_CLOSE}`; continue }
    cur.text += it.s
    const k = Math.round(h * 2) / 2
    cur.sizeChars.set(k, (cur.sizeChars.get(k) ?? 0) + it.s.replace(/\s/g, "").length)
  }
  for (const l of lines) {
    let best = 0, bestCount = -1
    for (const [size, count] of l.sizeChars) if (count > bestCount) { best = size; bestCount = count }
    l.size = best
    l.text = l.text.replace(/\s+/g, " ").trim()
  }
  return lines.filter((l) => l.text)
}

/** A running line's identity: digits as #, accents folded, spaces collapsed. */
const runKey = (t: string) =>
  t.normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u0001\u0002]/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase()

const mostCommon = (values: number[]): number | null => {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: number | null = null, bestCount = 0
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c }
  return best
}

interface LayoutBlock { text: string; page: number; size: number; footnote: boolean }

function readLayout(pages: readonly PdfPageContent[], joiner: TextJoiner, footnote: FootnoteMarker): PdfParagraph[] {
  const pagesLines = pages.map(layoutLines)
  // repeated top/bottom lines: running headers, footers, page numbers
  const inBand = (l: Line, p: PdfPageContent) => l.y > p.h * 0.9 || l.y < p.h * 0.1
  const seen = new Map<string, number>()
  pagesLines.forEach((lines, i) => {
    for (const l of lines) if (inBand(l, pages[i])) seen.set(runKey(l.text), (seen.get(runKey(l.text)) ?? 0) + 1)
  })
  const minRepeat = Math.min(3, pages.length)
  const isRunning = (l: Line, p: PdfPageContent) =>
    inBand(l, p) && ((pages.length > 1 && (seen.get(runKey(l.text)) ?? 0) >= minRepeat) || /^(page\s*)?([0-9]+|[ivxlc]+)$/i.test(l.text))
  // body size: the size carrying the most characters
  const sizeChars = new Map<number, number>()
  for (const lines of pagesLines) for (const l of lines) sizeChars.set(l.size, (sizeChars.get(l.size) ?? 0) + l.text.length)
  let body = 0, bodyChars = -1
  for (const [size, chars] of sizeChars) if (chars > bodyChars) { body = size; bodyChars = chars }

  const perPage: LayoutBlock[][] = pagesLines.map((lines, i) => {
    const p = pages[i]
    const kept = lines.filter((l) => !isRunning(l, p))
    // the column box: the left edge most body lines start at, the right edge most reach
    const bodyLines = kept.filter((l) => l.size === body)
    const colLeft = mostCommon(bodyLines.map((l) => Math.round(l.x))) ?? 0
    const rights = bodyLines.map((l) => l.right).sort((a, b) => a - b)
    const colRight = rights.length ? rights[Math.floor(rights.length * 0.9)] : p.w
    const pitch = new Map<number, number[]>()
    for (let k = 1; k < kept.length; k++) {
      const a = kept[k - 1], b = kept[k]
      if (a.size !== b.size) continue
      const g = Math.round((a.y - b.y) * 2) / 2
      if (g > 0) pitch.set(a.size, [...(pitch.get(a.size) ?? []), g])
    }
    const lead = (size: number) => {
      const g = [...(pitch.get(size) ?? [])].sort((x, y) => x - y)
      return g.length ? g[Math.floor(g.length * 0.3)] : size * 1.2
    }
    const blocks: { lines: Line[]; size: number; topY: number }[] = []
    let blk: { lines: Line[]; size: number; topY: number } | null = null
    let prev: Line | null = null
    for (const l of kept) {
      let brk = !blk || !prev
      if (!brk && prev) {
        const gap = prev.y - l.y
        const sizeChange = Math.abs(l.size - prev.size) > 0.12 * Math.max(l.size, prev.size)
        const newColumn = gap < -1
        // a paragraph cut by a column foot mid-sentence runs on at the next column's top
        const runsOn = newColumn && l.size === prev.size && !END_PUNCT.test(prev.text)
        const bigGap = gap > lead(l.size) * 1.3 || (newColumn && !runsOn)
        const startsItem = /^([•●▪◦○■\-–]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s/.test(l.text)
        // a first-line indent after a line that stopped short (a hanging
        // indent's run-on lines follow a FULL line, so they stay together)
        const prevShort = prev.right < colRight - 0.05 * (colRight - colLeft)
        const indentIn = l.x - colLeft > 0.8 * l.size && prev.x - colLeft < 0.3 * l.size && prevShort
        const shortPrev = prev.right < colRight - 0.12 * (colRight - colLeft) && END_PUNCT.test(prev.text)
        const tocPrev = /\.{4,}\s*\d+$/.test(prev.text)
        brk = sizeChange || bigGap || startsItem || indentIn || shortPrev || tocPrev
      }
      if (brk || !blk) {
        blk = { lines: [], size: l.size, topY: l.y }
        blocks.push(blk)
      }
      blk.lines.push(l)
      prev = l
    }
    // footnotes: small-type blocks below the last body-size line, starting with a number
    const lastBodyY = Math.min(...bodyLines.map((l) => l.y), Infinity)
    const built = blocks.map((b) => {
      let text = clean(b.lines.reduce((s, l) => (/\p{L}[-­]$/u.test(s) ? joiner.joinHyphen(s, l.text) : /\S[–—]$/u.test(s) ? s + l.text : `${s} ${l.text}`), ""))
      text = text.replace(/^[•●▪◦○■]\s*/, "")
      const isNote = b.size < body * 0.92 && b.topY < lastBodyY && /^\u0001?\d/.test(text)
      return { text, size: b.size, footnote: isNote, used: false }
    })
    // put each footnote at its mark, as the Word import does
    const notes = new Map<string, (typeof built)[number] & { body: string }>()
    for (const b of built) if (b.footnote) {
      const m = /^\u0001?(\d+)\u0002?\s*([\s\S]*)$/.exec(b.text)
      if (m) notes.set(m[1], Object.assign(b, { body: m[2].replace(/[\u0001\u0002]/g, "") }))
    }
    for (const b of built) if (!b.footnote) {
      // the note sits right after its word, as the Word import puts it
      b.text = b.text.replace(/(\s*)\u0001(\d+)\u0002/g, (_m, space: string, n: string) => {
        const note = notes.get(n)
        if (!note) return `${space}${n}`
        note.used = true
        return footnote(note.body)
      })
    }
    return built
      .filter((b) => !(b.footnote && b.used))
      .map((b) => ({ text: b.text.replace(/\u0001(\d+)\u0002/g, "$1"), page: p.n, size: b.size, footnote: b.footnote }))
      .filter((b) => b.text)
  })
  // Continuation only joins text of one size, so a heading set larger at the
  // top of a page is never run into the paragraph before it.
  return continueAcrossPages(perPage, (b) => !b.footnote, (a, b) => a.size === b.size)
    .map((b) => ({ text: b.text, heading: null, page: b.page }))
}

/** Read the pages' paragraphs: by tags when the PDF is tagged and its tags
 *  cover the text, otherwise by layout. */
export function pdfPagesToParagraphs(pages: readonly PdfPageContent[], footnote: FootnoteMarker): PdfReadResult {
  const joiner = new TextJoiner(pages)
  if (pages.some((p) => p.tree && (p.tree.children?.length ?? 0) > 0)) {
    const tagged = readTagged(pages, joiner, footnote)
    if (tagged.coverage >= MIN_TAG_COVERAGE && tagged.paragraphs.length > 0) return { paragraphs: tagged.paragraphs, tagged: true }
  }
  return { paragraphs: readLayout(pages, joiner, footnote), tagged: false }
}
