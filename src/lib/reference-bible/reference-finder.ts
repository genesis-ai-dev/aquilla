// AQU-1573: find explicit Scripture references in prose.
//
// A sermon cell says "Isaiah 40:25 says…", "(John 3:16)", "1 Cor. 13:4–7",
// "Romans 8:28; 12:1-2" or "John chapter 3, verse 16". Each one becomes a
// contiguous ScriptureRef the drafting prompt and the quote check look up in
// the lane's reference Bible. Only EXPLICIT references count (Sam, 2026-10-02):
// a quote with no reference, and a chapter-only reference ("Read Romans 8"),
// are left alone.
//
// Rules that keep ordinary prose from turning into references:
//   * the book name starts with a capital letter ("john 3:16" is not one);
//   * a chapter-only mention is not a reference (except one-chapter books,
//     where "Jude 3" is verse 3);
//   * zero-padded numbers ("5:05"), clock times ("5:30 pm", "5:30:00") and
//     the word-like abbreviations "Is"/"Am" outside the `c:v` form are not.
//
// No path aliases: auth-worker imports this file too (see types.ts).

import { BOOK_PATTERN, bookLabel, isSingleChapterBook, isWordLikeAlias, resolveBook } from "./book-aliases"
import type { FoundReference, ScriptureRef } from "./types"
import { isKnownBookCode } from "../file-labeling/bible-book-names"

/** Longest passage one reference may pull in; longer ranges are cut. */
export const MAX_VERSES_PER_REFERENCE = 30
/** Most verses one text may cite before later references are dropped. */
export const MAX_VERSES_PER_TEXT = 60

const MAX_CHAPTER = 150
const MAX_VERSE = 176

type Seg = { chapter: number; verseStart: number; endChapter: number; verseEnd: number; start: number; end: number }

class Cursor {
  readonly text: string
  pos: number
  constructor(text: string, pos: number) {
    this.text = text
    this.pos = pos
  }
  ws(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++
  }
  /** Match `re` (sticky) at the cursor; advance on success. */
  eat(re: RegExp): RegExpExecArray | null {
    const sticky = new RegExp(re.source, re.flags.includes("y") ? re.flags : re.flags + "y")
    sticky.lastIndex = this.pos
    const m = sticky.exec(this.text)
    if (m) this.pos = sticky.lastIndex
    return m
  }
  peek(re: RegExp): boolean {
    const sticky = new RegExp(re.source, re.flags.includes("y") ? re.flags : re.flags + "y")
    sticky.lastIndex = this.pos
    return sticky.test(this.text)
  }
}

/** A chapter or verse number: no zero padding, an optional "a"/"b" part letter. */
const NUM = /([1-9]\d{0,2})(?:[a-c](?![\p{L}]))?(?![\p{L}\p{N}])/u
const DASH = /\s*[-–—‐‑]\s*|\s+(?:to|through|thru)\s+/iu
const VERSE_WORD = /(?:verses|verse|vv\.?|vs\.?|v\.)\s*/iu
const CHAPTER_WORD = /(?:chapter|chap\.|ch\.)\s*/iu

function num(c: Cursor): { n: number; end: number } | null {
  const m = c.eat(NUM)
  return m ? { n: Number(m[1]), end: c.pos } : null
}

/** True when a book reference starts at the cursor ("2 Timothy" after a comma). */
function bookStartsAt(c: Cursor): boolean {
  return c.peek(new RegExp(BOOK_PATTERN.replace("(?<![\\p{L}\\p{N}])", ""), "iu"))
}

/**
 * `c:v` (or `c.v` when allowed). Returns chapter, verse and the cursor after
 * the verse; restores the cursor when it does not match.
 */
function chapterVerse(c: Cursor, allowDot: boolean): { chapter: number; verse: number; end: number } | null {
  const save = c.pos
  const ch = num(c)
  if (ch && c.eat(allowDot ? /[:.](?=[1-9])/u : /:(?=[1-9])/u)) {
    const v = num(c)
    if (v) return { chapter: ch.n, verse: v.n, end: v.end }
  }
  c.pos = save
  return null
}

/** Optional range end after a verse: "-18", "–4:2", " to 18". */
function rangeEnd(c: Cursor, chapter: number, verse: number, allowDot: boolean): { endChapter: number; verseEnd: number; end: number } | null {
  const save = c.pos
  if (!c.eat(DASH)) return null
  const cv = chapterVerse(c, allowDot)
  // "John 3:16-4:2" crosses chapters; "John 3:16-3:18" is written in full but stays in one.
  if (cv && (cv.chapter > chapter || (cv.chapter === chapter && cv.verse >= verse))) {
    return { endChapter: cv.chapter, verseEnd: cv.verse, end: cv.end }
  }
  if (!cv) {
    const v = num(c)
    if (v && v.n >= verse && !c.peek(/\s*[:.]\d/u)) return { endChapter: chapter, verseEnd: v.n, end: v.end }
  }
  c.pos = save
  return null
}

function segment(start: number, chapter: number, verse: number, range: ReturnType<typeof rangeEnd>, end: number): Seg {
  return {
    chapter,
    verseStart: verse,
    endChapter: range?.endChapter ?? chapter,
    verseEnd: range?.verseEnd ?? verse,
    start,
    end: range?.end ?? end,
  }
}

/** The first segment right after the book name. */
function firstSegment(c: Cursor, single: boolean, allowDot: boolean): Seg | null {
  const start = c.pos
  // Spoken: "chapter 3, verse 16", "3 verse 16", "chapter 3 verses 16-18".
  {
    const save = c.pos
    const hadChapterWord = !!c.eat(CHAPTER_WORD)
    const ch = num(c)
    if (ch) {
      const afterCh = c.pos
      c.eat(/\s*,?\s*/u)
      if (c.eat(VERSE_WORD)) {
        const v = num(c)
        if (v) return segment(start, ch.n, v.n, rangeEnd(c, ch.n, v.n, allowDot), v.end)
      }
      c.pos = afterCh
    }
    if (hadChapterWord) {
      c.pos = save
      return null
    }
    c.pos = save
  }
  const cv = chapterVerse(c, allowDot)
  if (cv) return segment(start, cv.chapter, cv.verse, rangeEnd(c, cv.chapter, cv.verse, allowDot), cv.end)
  if (single) {
    const v = num(c)
    if (v) return segment(start, 1, v.n, rangeEnd(c, 1, v.n, allowDot), v.end)
  }
  return null
}

/** Further segments: ", 18", " and 18-20", "; 12:1-2", ", 4:2". */
function nextSegment(c: Cursor, last: Seg, allowDot: boolean): Seg | null {
  const save = c.pos
  const sep = c.eat(/\s*(;|,|\band\b|&)\s*/iu)
  if (!sep) return null
  if (bookStartsAt(c)) {
    c.pos = save
    return null
  }
  const start = c.pos
  const cv = chapterVerse(c, allowDot)
  if (cv) return segment(start, cv.chapter, cv.verse, rangeEnd(c, cv.chapter, cv.verse, allowDot), cv.end)
  if (sep[1] !== ";") {
    const verseWord = !!c.eat(VERSE_WORD)
    const v = num(c)
    // A bare number must end the list item: "John 3:16, 18." or "3:16, 18-20",
    // not "Romans 8:28 and 2 more passages" or "John 3:16, 17 people came".
    // "and verse 18 tells us" names itself a verse, so it may run on.
    if (v && !c.peek(/\s*[:.]\d/u) && (verseWord || c.peek(LIST_ITEM_END))) {
      const chapter = last.endChapter
      return segment(start, chapter, v.n, rangeEnd(c, chapter, v.n, allowDot), v.end)
    }
  }
  c.pos = save
  return null
}

/** What may follow a bare verse number in a list: a range, another item, punctuation or the end. */
const LIST_ITEM_END = /(?:\s*(?:[-–—‐‑,;.:!?؟)\]"”»']|&|$)|\s+(?:and|to|through|thru)(?![\p{L}]))/iu

function valid(s: Seg): boolean {
  const inRange = (n: number, max: number) => n >= 1 && n <= max
  if (!inRange(s.chapter, MAX_CHAPTER) || !inRange(s.endChapter, MAX_CHAPTER)) return false
  if (!inRange(s.verseStart, MAX_VERSE) || !inRange(s.verseEnd, MAX_VERSE)) return false
  if (s.endChapter < s.chapter) return false
  return s.endChapter > s.chapter || s.verseEnd >= s.verseStart
}

/** "5:30 pm", "5:30:00", "5:30am" — a clock, not a verse. */
function looksLikeTime(text: string, end: number): boolean {
  return /^(?:\s*[ap]\.?\s?m\.?(?![\p{L}])|:\d)/iu.test(text.slice(end, end + 8))
}

export function formatCanonical(ref: ScriptureRef): string {
  const head = `${ref.book} ${ref.chapter}:${ref.verseStart}`
  if (ref.endChapter !== ref.chapter) return `${head}-${ref.endChapter}:${ref.verseEnd}`
  return ref.verseEnd !== ref.verseStart ? `${head}-${ref.verseEnd}` : head
}

export function formatLabel(ref: ScriptureRef): string {
  const head = `${bookLabel(ref.book, ref.endChapter === ref.chapter)} ${ref.chapter}:${ref.verseStart}`
  if (ref.endChapter !== ref.chapter) return `${head}–${ref.endChapter}:${ref.verseEnd}`
  return ref.verseEnd !== ref.verseStart ? `${head}–${ref.verseEnd}` : head
}

const CANONICAL = /^([1-3A-Z][A-Z0-9]{2}) ([1-9]\d{0,2}):([1-9]\d{0,2})(?:-(?:([1-9]\d{0,2}):)?([1-9]\d{0,2}))?$/

/** Parse the wire form ("ISA 40:25", "JHN 3:16-18", "JHN 3:16-4:2"). */
export function parseCanonicalRef(value: string): ScriptureRef | null {
  const m = CANONICAL.exec(value.trim())
  if (!m || !isKnownBookCode(m[1])) return null
  const chapter = Number(m[2])
  const verseStart = Number(m[3])
  const endChapter = m[4] ? Number(m[4]) : chapter
  const verseEnd = m[5] ? Number(m[5]) : verseStart
  const seg: Seg = { chapter, verseStart, endChapter, verseEnd, start: 0, end: 0 }
  return valid(seg) ? { book: m[1], chapter, verseStart, endChapter, verseEnd } : null
}

/** Verses a reference can pull in, for the per-text budget (cross-chapter counts as the cap). */
function verseEstimate(ref: ScriptureRef): number {
  if (ref.endChapter !== ref.chapter) return MAX_VERSES_PER_REFERENCE
  return Math.min(ref.verseEnd - ref.verseStart + 1, MAX_VERSES_PER_REFERENCE)
}

/**
 * Every explicit reference in `text`, in order. A reference that repeats an
 * earlier one is still returned (the quote check wants each place it is
 * cited) but costs nothing against the per-text verse budget.
 */
export function findScriptureReferences(text: string): FoundReference[] {
  const out: FoundReference[] = []
  if (!text || !/\d/.test(text)) return out
  const re = new RegExp(BOOK_PATTERN, "giu")
  const seen = new Set<string>()
  let budget = MAX_VERSES_PER_TEXT
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const [whole, ordinal, name] = m
    const nameStart = m.index + whole.indexOf(name, ordinal?.length ?? 0)
    const code = resolveBook(ordinal, name)
    if (!code) {
      // "3 Romans": not a book with that ordinal; retry from the name itself.
      if (ordinal) re.lastIndex = nameStart
      continue
    }
    // The name must be capitalised; the ordinal may be a word ("first John").
    if (!/^\p{Lu}/u.test(name)) continue
    const wordLike = isWordLikeAlias(name)
    const allowDot = !wordLike
    const c = new Cursor(text, m.index + whole.length)
    c.ws()
    const segs: Seg[] = []
    const first = firstSegment(c, isSingleChapterBook(code), allowDot)
    if (!first) {
      re.lastIndex = m.index + whole.length
      continue
    }
    segs.push(first)
    for (let next = nextSegment(c, first, allowDot); next; next = nextSegment(c, next, allowDot)) segs.push(next)
    re.lastIndex = Math.max(c.pos, m.index + whole.length)
    const lastEnd = segs[segs.length - 1].end
    if (looksLikeTime(text, lastEnd)) continue
    if (wordLike && !/:/.test(text.slice(first.start, first.end))) continue
    let stop = false
    segs.forEach((s, i) => {
      if (stop || !valid(s)) return
      let truncated = false
      let verseEnd = s.verseEnd
      if (s.endChapter === s.chapter && verseEnd - s.verseStart + 1 > MAX_VERSES_PER_REFERENCE) {
        verseEnd = s.verseStart + MAX_VERSES_PER_REFERENCE - 1
        truncated = true
      }
      const ref: ScriptureRef = { book: code, chapter: s.chapter, verseStart: s.verseStart, endChapter: s.endChapter, verseEnd }
      const canonical = formatCanonical(ref)
      if (!seen.has(canonical)) {
        const cost = verseEstimate(ref)
        if (cost > budget) {
          stop = true
          return
        }
        budget -= cost
        seen.add(canonical)
      }
      out.push({
        ref,
        canonical,
        label: formatLabel(ref),
        start: i === 0 ? m!.index : s.start,
        end: s.end,
        ...(truncated ? { truncated } : {}),
      })
    })
    if (stop) break
  }
  return out
}

/** Distinct canonical references, first occurrence order. */
export function uniqueReferences(found: readonly FoundReference[]): FoundReference[] {
  const seen = new Set<string>()
  return found.filter((f) => (seen.has(f.canonical) ? false : (seen.add(f.canonical), true)))
}
