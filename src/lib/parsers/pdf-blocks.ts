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
//    never sees Word's generated numbers (question 55). This is decided page
//    by page: a page with no tags, or whose tags reach little of its text, is
//    read by its layout, so a page added to a tagged PDF keeps its text.
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
  /** AQU-2680: pdf.js's name for the piece's font (its `fontName`). */
  font?: string
  /** AQU-2680: set in a bold or an italic face (from its font's name). */
  bold?: boolean
  italic?: boolean
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
  /** The page's box in the PDF's own coordinates, which text positions use
   *  (pdf.js `page.view`): it need not start at zero, and a rotated page's
   *  box is not swapped. */
  box: { x0: number; y0: number; x1: number; y1: number }
  items: PdfPageItem[]
  tree: PdfStructNode | null
}

/** AQU-2680: a tagged list item: bulleted or numbered (from its dropped
 *  label), and how deep it is nested (0 = a top-level item). */
export interface PdfListItem {
  kind: "bullet" | "number"
  level: number
  /** AQU-2680 review finding 1: how far the label sits from the page's
   *  starting edge (the right edge for right-to-left text), in points. Used
   *  for the depth, then dropped. */
  indent?: number
}

export interface PdfParagraph {
  text: string
  /** "Title", "Heading 1"…"Heading 6", "Heading" for a heading; null otherwise. */
  heading: string | null
  /** Set on a tagged PDF's list items only; an untagged PDF has no lists. */
  list?: PdfListItem
  /** AQU-2680: every piece of the paragraph's text is bold (or italic).
   *  Set only when the whole paragraph is: a word in a sentence has no place
   *  in the translated sentence. */
  bold?: true
  italic?: true
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

/** pdf.js puts a right-to-left run's combining marks before their letter.
 *  AQU-2551 review finding 10: decided for the whole piece, not by its first
 *  character. No word starts with a mark, so a right-to-left piece in which
 *  any word does ("ספר ְּבֵראִׁשית", " ְּבֵראִׁשית") is in pdf.js's reversed
 *  order and is repaired; one in which none does ("לֹא" in a Word PDF) is
 *  already in reading order. */
const MARK_AT_WORD_START = /(?:^|\s)\p{Mn}/u
/**
 * AQU-2551 review finding 7. `perGlyph`: the page draws its right-to-left
 * text one glyph at a time (see `drawnPerGlyph`), so a piece is one glyph and
 * its marks. A glyph that stands for several letters (Geeza Pro's lam-meem in
 * "المدرسة", the "الله" ligature) had its text reversed by pdf.js with the
 * run: it is reversed back. Then presentation forms become their letters.
 */
function repairRtl(piece: PdfTextPiece, perGlyph: boolean, script: ArabicScript): PdfTextPiece {
  let s = piece.s
  if (piece.dir === "rtl") {
    if (perGlyph && SEVERAL_LETTER_GLYPH.test(s)) s = unreverseGlyph(s)
    else if (MARK_AT_WORD_START.test(s)) s = s.replace(/(\p{Mn}+)(\p{L})/gu, "$2$1")
  }
  s = normalizePresentationForms(s, script)
  return s === piece.s ? piece : { ...piece, s }
}

/** One glyph's text as pdf.js gives it reversed: its marks, then two or more letters. */
const SEVERAL_LETTER_GLYPH = /^\p{Mn}*\p{L}{2,}$/u
const SHADDA = "\u0651"

/** A several-letter glyph's text back in reading order. Its letters are
 *  reversed; its marks (in drawing order once reversed) go to its letters
 *  from the last back, a shadda sharing its letter with one vowel, as Arabic
 *  writes it: "َْني" → "يْنَ", "َِّهلل" → "للَّهِ". */
function unreverseGlyph(s: string): string {
  const chars = [...s].reverse()
  const letters = chars.filter((c) => /\p{L}/u.test(c))
  const marks = chars.filter((c) => /\p{Mn}/u.test(c))
  const groups: string[][] = []
  for (const m of marks) {
    const last = groups[groups.length - 1]
    if (last && last.length === 1 && (last[0] === SHADDA) !== (m === SHADDA)) last.push(m)
    else groups.push([m])
  }
  const onLetter = letters.map(() => "")
  for (let g = groups.length - 1, k = letters.length - 1; g >= 0; g--, k = Math.max(0, k - 1)) {
    onLetter[k] = groups[g].join("") + onLetter[k]
  }
  return letters.map((l, i) => l + onLetter[i]).join("")
}

/** Arabic presentation forms (U+FB50–FDFF, U+FE70–FEFF), which Arial and
 *  Times map their glyphs to, as the letters they show (NFKC). A mark's own
 *  form decomposes with a space or a tatweel before the mark; both go.
 *  AQU-2551 re-review finding 2 (question 79): Arial and Times draw the
 *  Arabic yeh as the Persian yeh (U+06CC, or its forms) and the Arabic heh as
 *  the Urdu heh (U+06BE, or its forms; at a word's start Arial gives the
 *  letter itself). So, once the forms are letters: outside an Urdu document
 *  the Urdu heh is the Arabic heh, and outside a Persian or Urdu one the
 *  Persian yeh is the Arabic yeh. */
function normalizePresentationForms(s: string, script: ArabicScript): string {
  let out = /[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s)
    ? s.replace(/[\uFB50-\uFDFF\uFE70-\uFEFF]/g, (c) => c.normalize("NFKC").replace(/^[ \u0640]+(?=\p{Mn})/u, ""))
    : s
  if (script !== "urdu") out = out.replace(/\u06BE/g, "\u0647")
  if (script === "arabic") out = out.replace(/\u06CC/g, "\u064A")
  return out
}

/** AQU-2551 re-review finding 5: a lam-alef glyph (Arial's U+FEFB) carries
 *  its lam's vowel, and pdf.js gives it after the pair, on the alef. A bare
 *  alef takes no vowel or shadda (only a fathatan), so marks after a lam-alef
 *  go back on the lam: "لاَ" → "لَا", "إِلاَّ" → "إِلَّا". Run on the whole
 *  text, as a zero-width piece can carry the marks. */
const lamAlefMarks = (s: string) => s.replace(/\u0644\u0627([\u064C-\u0652]+)/g, "\u0644$1\u0627")

/** Which language an Arabic-script document is in, as far as its yeh and heh
 *  go (re-review finding 2). */
type ArabicScript = "arabic" | "persian" | "urdu"
/** Letters only Urdu uses, of the three: ٹ ڈ ڑ ں ے and the like. */
const URDU_LETTERS = /[\u0679\u0688\u0691\u06BA\u06BB\u06C1-\u06C3\u06D2\u06D3]/
/** Letters Persian (and Urdu) use and Arabic lacks: پ چ ژ گ, and the keheh ک. */
const PERSIAN_LETTERS = /[\u067E\u0686\u0698\u06AF\u06A9]/

/** Decided once for the whole document, from every page's text. */
function documentScript(pages: readonly PdfPageContent[]): ArabicScript {
  let persian = false
  for (const page of pages) for (const it of page.items) {
    if (!isPiece(it)) continue
    const s = it.s.normalize("NFKC")
    if (URDU_LETTERS.test(s)) return "urdu"
    if (PERSIAN_LETTERS.test(s)) persian = true
  }
  return persian ? "persian" : "arabic"
}

/** True when the page's right-to-left text is drawn one glyph a piece: most
 *  of its right-to-left pieces hold one letter. Then a piece with several
 *  letters is one glyph that stands for them. */
function drawnPerGlyph(page: PdfPageContent): boolean {
  let pieces = 0, single = 0
  for (const it of page.items) {
    if (!isPiece(it) || it.dir !== "rtl") continue
    const letters = it.s.match(/\p{L}/gu)?.length ?? 0
    if (letters === 0) continue
    pieces++
    if (letters === 1) single++
  }
  return pieces >= 8 && single >= 0.7 * pieces
}

/** Dot leaders (TOC lines) become one space; every whitespace run one space. */
const clean = (s: string) => s.replace(/\s*\.{5,}\s*/g, " ").replace(/\s+/g, " ").trim()

/** Word's heading numbers ("2.1.1.", "1.1. ", "3.1 ") are printed in a tagged
 *  PDF's heading text, not in a Lbl. Drop them, as the Word import never sees
 *  them (question 55). A bare number with no dot ("1 Corinthians") stays. */
const stripHeadingNumber = (s: string) => s.replace(/^(?:\d{1,3}(?:\.\d{1,2})+\.?|\d{1,3}\.)(?=\s|\p{L})\s*/u, "")

/** Inline notes (and a layout line's raised footnote mark) at a text's end,
 *  which say nothing about whether its sentence ended. */
const TRAILING_NOTES = /(?:\s*\\f\s(?:(?!\\f\*)[\s\S])*\\f\*|\s*\u0001\d+\u0002)+\s*$/
/** True when the text ends its sentence, ignoring notes after the full stop. */
const endsSentence = (text: string) => END_PUNCT.test(text.replace(TRAILING_NOTES, "").trim())

/** The gap between two pieces, in either reading direction. */
const gapBetween = (a: PdfTextPiece, b: PdfTextPiece) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
/** AQU-2551: a zero-width piece (marks drawn on their own) sits on the letter
 *  it is nearer. True when that is the next piece: Hebrew points drawn just
 *  before their letter, so the next piece is the same word. A shadda drawn
 *  after its letter (vowelled Arabic) is nearer that letter, and the next gap
 *  is measured from the letter. */
const marksOnNext = (mark: PdfTextPiece, letter: PdfTextPiece, next: PdfTextPiece) => gapBetween(mark, next) < gapBetween(letter, mark)

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
    let mark: PdfTextPiece | null = null
    let pendingBreak = false
    for (const it of parts) {
      if (!isPiece(it)) {
        // the note sits right after its word, as the Word import puts it
        s = s.replace(/\s+$/, "") + it.note
        if (it.eol && !/\s$/.test(s)) s += " "
        prev = null
        mark = null
        pendingBreak = false
        continue
      }
      if (it.s) {
        if (pendingBreak) {
          pendingBreak = false
          s = this.joinHyphen(s, it.s).slice(0, -it.s.length || undefined)
        } else if (prev && prev.w > 0 && it.w > 0 && !/\s$/.test(s) && !/^\s/.test(it.s) && !(mark && marksOnNext(mark, prev, it))) {
          // Two pieces on one baseline with a visible gap, in either reading
          // direction, and no space between them: one space.
          const h = Math.max(it.h, prev.h, 1)
          const gap = gapBetween(prev, it)
          if (Math.abs(it.y - prev.y) < 0.3 * h && gap > 0.15 * h) s += " "
        }
        s += it.s
        // AQU-2551 re-review finding 5: a zero-width piece (a shadda drawn on
        // its own) is no position to measure the next gap from
        if (it.w > 0 || !prev) { prev = it; mark = null } else mark = it
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

/** AQU-2680: a paragraph's whole-paragraph bold and italic, from its text pieces. */
interface WholeStyle { bold?: true; italic?: true }

function wholeStyle(pieces: readonly PdfTextPiece[]): WholeStyle {
  const visible = pieces.filter((p) => p.s.trim() !== "")
  if (visible.length === 0) return {}
  return {
    ...(visible.every((p) => p.bold) ? { bold: true as const } : {}),
    ...(visible.every((p) => p.italic) ? { italic: true as const } : {}),
  }
}

interface TaggedBlock extends WholeStyle {
  role: string
  text: string
  list?: PdfListItem
  page: number
  /** Index of the block's first drawn piece on its page. */
  order: number
}

interface Coverage { tagged: number; untagged: number }

function readTaggedPage(page: PdfPageContent, joiner: TextJoiner, footnote: FootnoteMarker, coverage: Coverage, script: ArabicScript): TaggedBlock[] {
  // marked-content id → its pieces, in drawing order
  const byId = new Map<string, (PdfTextPiece & { order: number })[]>()
  const stack: { id: string | null; tag: string | null }[] = []
  const perGlyph = drawnPerGlyph(page)
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
      list.push({ ...repairRtl(it, perGlyph, script), order })
      byId.set(owner, list)
    } else if (!stack.some((e) => e.tag === "Artifact")) {
      coverage.untagged += it.s.trim().length
    }
  })
  const used = new Set<string>()
  const blocks: TaggedBlock[] = []
  let cur: { role: string; parts: Part[]; list?: PdfListItem } | null = null
  /** AQU-2680: how many lists (L) the walk is inside. */
  let listDepth = 0

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
      blocks.push({ role: cur.role, text, page: page.n, order: Math.min(...pieces.map((p) => p.order)), ...(cur.list ? { list: cur.list } : {}), ...wholeStyle(pieces) })
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
      if (role === "Lbl") {
        // AQU-2680: the label is dropped from the text, but says whether the
        // item is numbered ("1.", "iv)", "(a)") or bulleted ("•", "o", "–").
        const labelParts = contentOf(c).filter((p): p is PdfTextPiece & { order: number } => isPiece(p) && p.s.trim() !== "")
        const label = clean(joiner.join(labelParts))
        if (cur?.list && label) {
          // review finding 1: the label's place on the page gives the depth
          const rtl = labelParts.some((p) => p.dir === "rtl")
          const indent = rtl ? page.box.x1 - Math.max(...labelParts.map((p) => p.x + p.w)) : Math.min(...labelParts.map((p) => p.x)) - page.box.x0
          cur.list = { ...cur.list, kind: listKind(label), indent: Math.round(indent * 10) / 10 }
        }
        continue
      }
      if (role === "L") {
        listDepth++
        visit(c, inBlock)
        listDepth--
        continue
      }
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
        const outerList = cur?.list
        // review finding 4: LI > Lbl + LBody > P: the item's first paragraph,
        // opened before the item has any text, is the list item
        const takesList = role !== "LI" && outer === "LI" && outerList !== undefined
          && !cur!.parts.some((p) => isPiece(p) && p.s.trim() !== "")
        flush()
        const list = role === "LI" ? { kind: "bullet" as const, level: Math.min(8, Math.max(0, listDepth - 1)) } : takesList ? outerList : undefined
        cur = { role, parts: [], ...(list ? { list } : {}) }
        visit(c, true)
        flush()
        if (outer && inBlock) cur = { role: outer, parts: [], ...(outerList && !takesList ? { list: outerList } : {}) }
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

/** AQU-2680: a list label that counts (digits, or a letter or roman numeral
 *  with its "." or ")") marks a numbered item; anything else is a bullet. */
function listKind(label: string): PdfListItem["kind"] {
  return /^\(?(\d+(\.\d+)*[.)]?|[a-z][.)]|[ivxlcdm]+[.)])$/i.test(label.trim()) ? "number" : "bullet"
}

function headingContext(role: string): string | null {
  if (!HEADING_ROLE.test(role)) return null
  if (role === "Title") return "Title"
  return role === "H" ? "Heading" : `Heading ${role.slice(1)}`
}

/** One page's block, from either reader. */
interface PageBlock extends WholeStyle {
  text: string
  page: number
  heading: string | null
  list?: PdfListItem
  /** Ordinary body text, which page continuation may join. */
  body: boolean
  /** The layout reader's text size; null from the tags. */
  size: number | null
}

/** Page continuation: the first body paragraph of a page continues the last
 *  one of the previous page when that one stopped mid-sentence. A paragraph
 *  may run over any number of pages; a word hyphenated across the page break
 *  is joined by the spacing rule. The layout reader only joins text of one
 *  size, so a heading set larger at a page's top never runs into the
 *  paragraph before it. */
function continueAcrossPages(pages: readonly PageBlock[][], joiner: TextJoiner): PdfParagraph[] {
  const out: (PageBlock & { endPage: number })[] = []
  for (const blocks of pages) {
    blocks.forEach((b, i) => {
      const prev = out[out.length - 1]
      if (
        i === 0 && prev && prev.body && b.body && b.page === prev.endPage + 1
        && (prev.size === null || b.size === null || prev.size === b.size)
        && !endsSentence(prev.text)
      ) {
        const joined = /\p{L}[-\u00ad]$/u.test(prev.text) ? joiner.joinHyphen(prev.text, b.text)
          : /\S[–—]$/u.test(prev.text) ? prev.text + b.text
          : `${prev.text} ${b.text}`
        // AQU-2680: the joined paragraph is bold (italic) only if both halves are
        out[out.length - 1] = { ...prev, text: clean(joined), endPage: b.page, bold: prev.bold && b.bold, italic: prev.italic && b.italic }
        return
      }
      out.push({ ...b, endPage: b.page })
    })
  }
  return out.map((b) => ({
    text: b.text, heading: b.heading, page: b.page,
    ...(b.list ? { list: b.list } : {}), ...(b.bold ? { bold: true as const } : {}), ...(b.italic ? { italic: true as const } : {}),
  })).filter((p) => p.text)
}

/** The tagged reader's blocks for one page, and whether its tags reach the
 *  page's text (MIN_TAG_COVERAGE). */
function taggedPageBlocks(page: PdfPageContent, joiner: TextJoiner, footnote: FootnoteMarker, script: ArabicScript): { blocks: PageBlock[]; byTags: boolean } {
  if (!page.tree || (page.tree.children?.length ?? 0) === 0) return { blocks: [], byTags: false }
  const coverage: Coverage = { tagged: 0, untagged: 0 }
  const blocks = readTaggedPage(page, joiner, footnote, coverage, script).map((b): PageBlock => {
    const heading = headingContext(b.role)
    return { text: heading ? stripHeadingNumber(b.text) : b.text, page: b.page, heading, body: b.role === "P", size: null, ...(b.list ? { list: b.list } : {}), bold: b.bold, italic: b.italic }
  })
  const total = coverage.tagged + coverage.untagged
  return { blocks, byTags: blocks.length > 0 && total > 0 && coverage.tagged / total >= MIN_TAG_COVERAGE }
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
  /** A zero-width piece after `prev`, if any (see marksOnNext). */
  mark: PdfTextPiece | null
  /** The last piece that is not one of pdf.js's zero-height spaces. */
  lastReal: PdfTextPiece | null
  /** Letters in right-to-left pieces minus the others: the line reads
   *  right to left when positive. */
  rtlBalance: number
  rtl: boolean
  /** AQU-2680: every visible piece of the line is bold (italic). */
  bold: boolean
  italic: boolean
}

// Private-use sentinels around a raised footnote number in a line.
const MARK_OPEN = "\u0001"
const MARK_CLOSE = "\u0002"

function layoutLines(page: PdfPageContent, script: ArabicScript): Line[] {
  const lines: Line[] = []
  let cur: Line | null = null
  const perGlyph = drawnPerGlyph(page)
  for (const raw of page.items) {
    if (!isPiece(raw) || !raw.s) continue
    if (Math.abs(raw.b) > 0.01) continue // rotated text is not reading text
    const it = repairRtl(raw, perGlyph, script)
    const h = Math.max(it.h, 1)
    // gap to the previous piece, reading left-to-right or right-to-left
    const gap: number = cur?.prev ? Math.max(it.x - (cur.prev.x + cur.prev.w), cur.prev.x - (it.x + it.w)) : 0
    // A new line: the baseline moved, or a wide jump sideways (a table cell,
    // a second column). pdf.js's own end-of-line flags are not trusted, so a
    // raised superscript stays on its line. AQU-2551 re-review finding 4: the
    // jump is measured for right-to-left pieces too, so a Hebrew or Arabic
    // table splits into its cells (it skipped them, and a right-to-left table
    // came in as one paragraph).
    // AQU-2551 review finding 6: the zero-height space pdf.js adds between
    // two pieces is not a position (after a right-to-left run it sits where
    // the run began), so it never starts a line, and a jump is measured from
    // the last real piece before it.
    const zeroSpace = it.h === 0 && !it.s.trim()
    const from = cur?.lastReal ?? null
    const jump = from ? Math.max(it.x - (from.x + from.w), from.x - (it.x + it.w)) : 0
    const newLine = !cur
      || Math.abs(it.y - cur.y) > 0.45 * Math.max(h, cur.h)
      || (!zeroSpace && jump > 3 * h)
    const sup = !!cur && !newLine && h < 0.85 * cur.h && it.y - cur.y > 0.12 * cur.h
    if (newLine || !cur) {
      cur = { y: it.y, x: it.x, right: it.x + it.w, h, size: 0, sizeChars: new Map(), text: "", prev: null, mark: null, lastReal: null, rtlBalance: 0, rtl: false, bold: true, italic: true }
      lines.push(cur)
    } else if (!sup && cur.prev && !cur.prev.sup && cur.prev.w > 0 && it.w > 0 && gap > 0.15 * h && !/\s$/.test(cur.text) && !/^\s/.test(it.s) && !(cur.mark && marksOnNext(cur.mark, cur.prev, it))) {
      cur.text += " "
    }
    // re-review finding 5: as in TextJoiner.join, a zero-width piece is not
    // where the next gap is measured from, so it never joins two words
    if (it.w > 0 || !cur.prev) { cur.prev = { ...it, sup }; cur.mark = null } else cur.mark = it
    if (!zeroSpace) {
      cur.lastReal = it
      cur.x = Math.min(cur.x, it.x)
      cur.h = Math.max(cur.h, h)
      cur.right = Math.max(cur.right, it.x + it.w)
    }
    if (sup && /^\s*\d{1,3}\s*$/.test(it.s)) { cur.text += `${MARK_OPEN}${it.s.trim()}${MARK_CLOSE}`; continue }
    cur.text += it.s
    if (it.s.trim()) { cur.bold &&= it.bold === true; cur.italic &&= it.italic === true }
    cur.rtlBalance += (it.dir === "rtl" ? 1 : -1) * (it.s.match(/\p{L}/gu)?.length ?? 0)
    const k = Math.round(h * 2) / 2
    cur.sizeChars.set(k, (cur.sizeChars.get(k) ?? 0) + it.s.replace(/\s/g, "").length)
  }
  for (const l of lines) {
    let best = 0, bestCount = -1
    for (const [size, count] of l.sizeChars) if (count > bestCount) { best = size; bestCount = count }
    l.size = best
    l.rtl = l.rtlBalance > 0
    l.text = l.text.replace(/\s+/g, " ").trim()
  }
  return lines.filter((l) => l.text)
}

/** A running line's identity: digits as #, accents folded, spaces collapsed. */
const runKey = (t: string) =>
  t.normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u0001\u0002]/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase()

/** The most common value; on a tie the smallest (the outermost edge). */
const mostCommon = (values: number[]): number | null => {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: number | null = null, bestCount = 0
  for (const [v, c] of counts) if (c > bestCount || (c === bestCount && best !== null && v < best)) { best = v; bestCount = c }
  return best
}

/** AQU-2551 review finding 5: a line's start and end edges in its reading
 *  direction. A right-to-left line starts at its right edge, so its edges are
 *  measured mirrored (negated): a right indent is then an indent, and a line
 *  that stops short on the left is short, by the same tests as left to right. */
const lineStart = (l: Line) => (l.rtl ? -l.right : l.x)
const lineEnd = (l: Line) => (l.rtl ? -l.x : l.right)

/** A page number: digits, or a Roman numeral ("civil" is not one). */
const PAGE_NUMBER = /^(?:page\s*)?(?:\d+|(?=[ivxlcdm]+$)m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i

/** A label beside its text: a list number or letter ("1.", "(a)", "iv."),
 *  a bullet, or a short term (up to four words) ending in a colon or dash. */
const LABEL = /^(?:[•●▪◦○■\-–]|\(?(?:\d{1,3}|[a-z]|[ivxlc]{1,6})[.)]|[^\s:–—-]+(?: [^\s:–—-]+){0,3} ?[:–—-])$/iu

/** The layout reader's blocks, page by page, before page continuation. */
function layoutPageBlocks(pages: readonly PdfPageContent[], joiner: TextJoiner, footnote: FootnoteMarker, script: ArabicScript): PageBlock[][] {
  const pagesLines = pages.map((p) => layoutLines(p, script))
  // repeated top/bottom lines: running headers, footers, page numbers
  const inBand = (l: Line, p: PdfPageContent) => {
    const tenth = (p.box.y1 - p.box.y0) * 0.1
    return l.y > p.box.y1 - tenth || l.y < p.box.y0 + tenth
  }
  const seen = new Map<string, number>()
  pagesLines.forEach((lines, i) => {
    for (const l of lines) if (inBand(l, pages[i])) seen.set(runKey(l.text), (seen.get(runKey(l.text)) ?? 0) + 1)
  })
  const minRepeat = Math.min(3, pages.length)
  const isRunning = (l: Line, p: PdfPageContent) =>
    inBand(l, p) && ((pages.length > 1 && (seen.get(runKey(l.text)) ?? 0) >= minRepeat) || PAGE_NUMBER.test(l.text))
  // body size: the size carrying the most characters
  const sizeChars = new Map<number, number>()
  for (const lines of pagesLines) for (const l of lines) sizeChars.set(l.size, (sizeChars.get(l.size) ?? 0) + l.text.length)
  let body = 0, bodyChars = -1
  for (const [size, chars] of sizeChars) if (chars > bodyChars) { body = size; bodyChars = chars }

  return pagesLines.map((lines, i): PageBlock[] => {
    const p = pages[i]
    const kept = lines.filter((l) => !isRunning(l, p))
    // the column box, per reading direction: the edge most body lines start
    // at, and the edge most reach
    const bodyLines = kept.filter((l) => l.size === body)
    const columnBox = (rtl: boolean) => {
      const lines = bodyLines.filter((l) => l.rtl === rtl)
      const start = mostCommon(lines.map((l) => Math.round(lineStart(l)))) ?? (rtl ? -p.box.x1 : 0)
      const ends = lines.map(lineEnd).sort((a, b) => a - b)
      const end = ends.length ? ends[Math.floor(ends.length * 0.9)] : rtl ? -p.box.x0 : p.box.x1
      return { start, end }
    }
    const boxes = { ltr: columnBox(false), rtl: columnBox(true) }
    const boxOf = (l: Line) => (l.rtl ? boxes.rtl : boxes.ltr)
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
    // AQU-2551 review finding 8: lines drawn one after another on the same
    // baseline are a table row's cells (a wide jump sideways split them).
    // Each cell is its own paragraph, row by row, as the Word import gives a
    // table; before this a table came in as one paragraph.
    const sameBaseline = (a: Line, b: Line) => Math.abs(a.y - b.y) < 0.45 * Math.max(a.h, b.h)
    // AQU-2551 re-review finding 3: a label beside its text (a list's number
    // in its own margin column, a glossary's term) is two lines on one
    // baseline too. Lines are cells only when two or more rows in a row share
    // their column starts: two of their starts line up, in reading direction.
    const rows: Line[][] = []
    const rowOf = kept.map((l, k) => {
      if (k > 0 && sameBaseline(kept[k - 1], l)) rows[rows.length - 1].push(l)
      else rows.push([l])
      return rows.length - 1
    })
    // AQU-2551 check of fix 2: a row of two lines whose first (in reading
    // direction) is a label (a list number, or a short term ending in a colon
    // or dash) is a label and its text, never table cells, even when the
    // next item's row lines up with it (one-line list items, a glossary).
    const labelRow = (r: Line[]) => r.length === 2 && LABEL.test([...r].sort((x, y) => lineStart(x) - lineStart(y))[0].text)
    const shareStarts = (a: Line[], b: Line[]) => {
      if (a.length < 2 || b.length < 2 || labelRow(a) || labelRow(b)) return false
      const tol = 0.3 * Math.max(...a.map((l) => l.size), ...b.map((l) => l.size))
      return a.filter((x) => b.some((y) => Math.abs(lineStart(x) - lineStart(y)) <= tol)).length >= 2
    }
    const tableRow = rows.map((r, i) => (i > 0 && shareStarts(rows[i - 1], r)) || (i + 1 < rows.length && shareStarts(r, rows[i + 1])))
    const isCell = kept.map((_, k) => tableRow[rowOf[k]])
    const blocks: { lines: Line[]; size: number; topY: number }[] = []
    let blk: { lines: Line[]; size: number; topY: number } | null = null
    let prev: Line | null = null
    for (const [k, l] of kept.entries()) {
      let brk = !blk || !prev || isCell[k] || isCell[k - 1]
      if (!brk && prev) {
        const gap = prev.y - l.y
        const sizeChange = Math.abs(l.size - prev.size) > 0.12 * Math.max(l.size, prev.size)
        const newColumn = gap < -1
        // a paragraph cut by a column foot mid-sentence runs on at the next column's top
        const runsOn = newColumn && l.size === prev.size && !endsSentence(prev.text)
        const bigGap = gap > lead(l.size) * 1.3 || (newColumn && !runsOn)
        const startsItem = /^([•●▪◦○■\-–]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s/.test(l.text)
        // a first-line indent after a line that stopped short (a hanging
        // indent's run-on lines follow a FULL line, so they stay together)
        const box = boxOf(l), prevBox = boxOf(prev)
        const prevWidth = prevBox.end - prevBox.start
        const prevShort = lineEnd(prev) < prevBox.end - 0.05 * prevWidth
        const indentIn = lineStart(l) - box.start > 0.8 * l.size && lineStart(prev) - prevBox.start < 0.3 * l.size && prevShort
        const shortPrev = lineEnd(prev) < prevBox.end - 0.12 * prevWidth && endsSentence(prev.text)
        const tocPrev = /\.{4,}\s*\d+$/.test(prev.text)
        // re-review finding 3: a label on its text's baseline ("1.", a
        // glossary's term) runs on into its text, whatever it ends with
        const label = sameBaseline(prev, l)
        // a label row (see labelRow) starts its own item
        brk = !label && (sizeChange || bigGap || startsItem || labelRow(rows[rowOf[k]]) || indentIn || shortPrev || tocPrev)
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
      const style: WholeStyle = {
        ...(b.lines.every((l) => l.bold) ? { bold: true as const } : {}),
        ...(b.lines.every((l) => l.italic) ? { italic: true as const } : {}),
      }
      return { text, size: b.size, footnote: isNote, used: false, style }
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
      .map((b): PageBlock => ({ text: b.text.replace(/\u0001(\d+)\u0002/g, "$1"), page: p.n, heading: null, body: !b.footnote, size: b.size, ...b.style }))
      .filter((b) => b.text)
  })
}

/** Read the pages' paragraphs. Each page is read by its tags when it has them
 *  and they reach its text, otherwise by its layout, so a page added to a
 *  tagged PDF without tags keeps its text. */
export function pdfPagesToParagraphs(pages: readonly PdfPageContent[], footnote: FootnoteMarker): PdfReadResult {
  const joiner = new TextJoiner(pages)
  const script = documentScript(pages)
  const tagged = pages.map((p) => taggedPageBlocks(p, joiner, footnote, script))
  const anyTags = tagged.some((t) => t.byTags)
  const layout = anyTags && tagged.every((t) => t.byTags) ? null : layoutPageBlocks(pages, joiner, footnote, script)
  const perPage = pages.map((_, i) => (tagged[i].byTags ? tagged[i].blocks : layout![i]))
  const paragraphs = listLevelsByIndent(continueAcrossPages(perPage, joiner).map((p) => ({ ...p, text: lamAlefMarks(p.text) })))
  return { paragraphs, tagged: anyTags }
}

/** AQU-2680 review finding 1: a list item's depth is where its label sits,
 *  not how its tags nest (Word nests each later list in the previous list's
 *  last item, so the tags' depth creeps). Within a run of list items with no
 *  other paragraph between them, the label indents are ranked, indents within
 *  LIST_INDENT_SAME points of each other counting as one; the nearest the
 *  page's edge is depth 0. Each run ranks its own: Word sets each list at its
 *  own indent, so a later list further in is not deeper. An item with no
 *  label takes the depth of the item before it. */
const LIST_INDENT_SAME = 4
function listLevelsByIndent(paragraphs: PdfParagraph[]): PdfParagraph[] {
  const out = [...paragraphs]
  for (let start = 0; start < out.length; start++) {
    if (!out[start].list) continue
    let end = start
    while (end < out.length && out[end].list) end++
    const indents = [...new Set(out.slice(start, end).flatMap((p) => (p.list!.indent !== undefined ? [p.list!.indent] : [])))].sort((a, b) => a - b)
    const steps: number[] = []
    for (const x of indents) if (steps.length === 0 || x - steps[steps.length - 1] > LIST_INDENT_SAME) steps.push(x)
    let level = 0
    for (let k = start; k < end; k++) {
      const { indent, ...list } = out[k].list!
      if (indent !== undefined) level = Math.min(8, Math.max(0, steps.filter((step) => step <= indent).length - 1))
      out[k] = { ...out[k], list: { ...list, level } }
    }
    start = end - 1
  }
  return out
}
