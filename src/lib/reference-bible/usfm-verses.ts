// AQU-1573: pull plain verse text out of a USFM book.
//
// The reference Bibles are loaded from eBible.org's USFM (scripts/
// reference-bibles.ts refresh). What a reader of the printed Bible sees as the
// verse is kept; everything else is editorial apparatus and is dropped:
//   kept     \v text, plus continuation lines and paragraph/poetry breaks
//            inside a verse (\p \q1 \m \b …), joined with a space;
//   dropped  headers (\id \h \toc \mt), section heads (\ms \s \r \sp \qa
//            \cl), psalm titles (\d — USFM keeps them out of verse 1, which
//            is why this reads USFM and not eBible's VPL), remarks, intro
//            paragraphs, footnotes \f…\f* and cross references \x…\x*;
//   unwrapped character markers (\w word|strong="…"\w*, \+w, \add, \nd, \wj,
//            \tl …): the marker and its attributes go, the words stay. So
//            the KJV's italic supplied words are kept, without brackets.
// The pilcrow (¶) eBible's KJV carries is removed and whitespace collapsed.
//
// No path aliases: auth-worker imports this file too (see types.ts).

import type { ReferenceVerseRow } from "./types"

/** Paragraph-level markers whose text is not verse text. */
const DROPPED_PARAGRAPH = /^(?:id|ide|h\d?|toc\d|toca\d|mt\d?|mte\d?|ms\d?|mr|s\d?|sr|r|d|cl|cd|qa|sp|rem|sts|usfm|restore|periph|i[a-z]*\d?|lit)$/
/** Notes and alternate numbering: the whole span goes, content included. */
const DROPPED_SPANS = /\\(f|fe|ef|x|ex|fig|va|vp|ca|rq)\b[\s\S]*?\\\1\*/g
/** Character markers whose words are verse text; only the markup goes. */
const CHARACTER = /^\+?(?:w|add|nd|wj|tl|qs|qac|sc|bk|it|bd|bdit|em|k|pn|png|ord|sig|sls|no|dc|addpn|rb|wg|wh|wa|sup|jmp|lik|liv|litl|fv|fq|fk|ft)$/

/**
 * Verses of every book in `usfm`, in file order. A file normally holds one
 * book; each `\id` starts a new one, so a test fixture can hold several.
 */
export function extractUsfmVerses(usfm: string): ReferenceVerseRow[] {
  const text = usfm
    .replace(/\r\n?/g, "\n")
    .replace(DROPPED_SPANS, " ")
    // \w word|strong="H7225"\w*  →  \w word\w*  (attributes run to the closing marker)
    .replace(/\|[^\\|]*(?=\\\+?[a-z]+\d*\*)/g, "")

  const rows: ReferenceVerseRow[] = []
  let book = ""
  let chapter = 0
  let verse = 0
  let buf: string[] = []
  let dropping = false

  const flush = () => {
    if (book && chapter > 0 && verse > 0) {
      const t = clean(buf.join(""))
      if (t) rows.push({ book, chapter, verse, text: t })
    }
    buf = []
  }

  // Split into marker tokens and the text between them.
  const re = /\\(\+?[a-z]+\d*)(\*?)/g
  let last = 0
  let m: RegExpExecArray | null
  const takeText = (until: number) => {
    if (!dropping && verse > 0) buf.push(text.slice(last, until))
  }
  while ((m = re.exec(text)) !== null) {
    takeText(m.index)
    const [, marker, closing] = m
    last = re.lastIndex
    if (closing) continue
    // The one space after an opening marker belongs to the marker, not the
    // text: "\add s\add*" must stay glued to the word before it.
    if (text[last] === " ") last++
    if (CHARACTER.test(marker)) continue
    if (marker === "id") {
      flush()
      const n = /^\s*([1-4A-Z][A-Z0-9]{2})\b/.exec(text.slice(last))
      book = n ? n[1] : ""
      chapter = 0
      verse = 0
      dropping = true
      continue
    }
    if (marker === "c") {
      flush()
      const n = /^\s*(\d+)/.exec(text.slice(last))
      chapter = n ? Number(n[1]) : chapter
      verse = 0
      dropping = false
      if (n) last += n[0].length
      continue
    }
    if (marker === "v") {
      flush()
      const n = /^\s*(\d+)(?:[a-z])?(?:-\d+[a-z]?)?\s?/.exec(text.slice(last))
      verse = n ? Number(n[1]) : 0
      dropping = false
      if (n) last += n[0].length
      continue
    }
    // Any other paragraph marker either starts dropped text (a heading,
    // a psalm title) or continues the open verse on a new line.
    dropping = DROPPED_PARAGRAPH.test(marker)
    if (!dropping && verse > 0) buf.push(" ")
  }
  takeText(text.length)
  flush()
  return rows
}

function clean(s: string): string {
  return s.replace(/¶/g, " ").replace(/\s+/g, " ").trim()
}
