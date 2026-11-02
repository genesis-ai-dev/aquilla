// AQU-981: read what a recording's file name says — a book, the numbers after
// it, and any marker that a number is a chapter, a verse, a line, a part or a
// take. Pure and context-free: deciding what the numbers MEAN (chapter and
// verse in a Bible file, a line number in a document) needs the whole folder
// and the destination, which is match.ts's job.

import { BookNameIndex } from "./book-names"

export type NumberMarker = "chapter" | "verse" | "line" | "part" | "take"

export interface NameNumber {
  value: number
  /** The separator text before this number ("-", "_", ":", " "), trimmed of
   *  spaces unless it was only spaces. "" when it touches the token before. */
  sepBefore: string
  /** A word right before it that says what it is ("chapter 3", "v12", "3章"). */
  marker?: NumberMarker
  /** A single letter run on to it ("4a", "012b"). */
  letter?: string
}

export interface NameReading {
  /** The name without its extension, as shown. */
  stem: string
  book: { code: string; fromProject: boolean } | null
  /** The numbers that follow the book (or, with no book, every number), up to
   *  the first ordinary word after them. */
  numbers: NameNumber[]
  /** A part said in words after the numbers: "beginning", "middle", "end". */
  partWord: { rank: number; word: string } | null
  /** The text words that are not the book, a marker or a part word. */
  words: string[]
  /** A word sitting where a book would be (right before the first number) that
   *  no table knows — the hint that the project may call its books something
   *  the built-in table does not. */
  unknownBookWord: string | null
}

const DASHES = /^(?:-|–|—|‑|‐|−|~|～|to|through|thru|至|到)$/u

/** True when the separator before a number joins it to the one before as a range. */
export function isRangeSep(sep: string): boolean {
  return DASHES.test(sep.trim().toLowerCase())
}

const MARKERS: ReadonlyMap<string, NumberMarker> = new Map([
  ...["chapter", "chapters", "chap", "ch", "c", "cap", "kap", "kapitel", "chapitre", "capitulo", "capítulo", "pasal", "bab", "章", "篇"].map((w) => [w, "chapter"] as const),
  ...["verse", "verses", "vers", "vs", "vv", "ver", "v", "versiculo", "versículo", "verset", "ayat", "节", "節"].map((w) => [w, "verse"] as const),
  ...["line", "lines", "ln", "row", "track", "trk", "cue", "seg", "segment", "clip", "no", "nr", "num", "number", "item", "sentence", "para", "paragraph"].map((w) => [w, "line"] as const),
  ...["part", "pt", "p", "piece", "pc", "parte", "partie", "bagian"].map((w) => [w, "part"] as const),
  ...["take", "tk"].map((w) => [w, "take"] as const),
])

/** Markers written after their number. */
const POSTFIX_MARKERS = new Set(["章", "篇", "节", "節"])

/** Words that place a part without a number. */
const PART_WORDS: ReadonlyMap<string, number> = new Map([
  ["beginning", 1], ["begin", 1], ["start", 1],
  ["middle", 2], ["mid", 2],
  ["end", 3], ["ending", 3],
])

/** Words with no meaning of their own here ("第" is the ordinal prefix of "第3章"). */
const NOISE = new Set(["第", "of", "and", "&"])

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** "十二" → 12, "一百五十" → 150. Up to the hundreds, which is every chapter and verse. */
function chineseNumber(text: string): number | null {
  let total = 0
  let current = 0
  for (const ch of text) {
    if (ch in CN_DIGITS) current = CN_DIGITS[ch]
    else if (ch === "十") { total += (current || 1) * 10; current = 0 }
    else if (ch === "百") { total += (current || 1) * 100; current = 0 }
    else return null
  }
  return total + current
}

/**
 * The Chinese chapter and verse words stand alone, and Chinese numerals next
 * to them become digits: "创世记第一章第三节" → "创世记 第 1 章 第 3 节". 诗篇
 * (Psalms) holds 篇, the Psalm-chapter word, so it is kept whole first.
 */
function splitChineseMarkers(text: string): string {
  const PSALMS = "\u0000"
  return text
    .replace(/诗篇|詩篇/gu, (m) => (m === "诗篇" ? `${PSALMS}s` : `${PSALMS}t`))
    .replace(/([第])?([零〇一二两三四五六七八九十百]+)(?=[章节節篇])/gu, (_m, di: string | undefined, num: string) => {
      const n = chineseNumber(num)
      return n == null ? `${di ?? ""}${num}` : `${di ?? ""} ${n} `
    })
    .replace(/第([零〇一二两三四五六七八九十百]+)/gu, (_m, num: string) => {
      const n = chineseNumber(num)
      return n == null ? `第${num}` : ` 第 ${n} `
    })
    .replace(/([第章节節篇])/gu, " $1 ")
    .replace(new RegExp(`${PSALMS}([st])`, "gu"), (_m, w: string) => (w === "s" ? "诗篇" : "詩篇"))
}

type Tok =
  | { kind: "num"; text: string; value: number; letter?: string }
  | { kind: "word"; text: string }
  | { kind: "sep"; text: string }

/** Strip a real extension (".mp3", ".wav"), never a dotted reference ("Gen 1.1"). */
export function nameStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const m = /^(.*)\.([A-Za-z][A-Za-z0-9]{1,4})$/.exec(base)
  return m && m[1].length > 0 ? m[1] : base
}

function tokenize(stem: string): Tok[] {
  const text = splitChineseMarkers(stem.normalize("NFKC"))
  const out: Tok[] = []
  const re = /(\d+)|(\p{L}+)|([^\p{L}\d]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) out.push({ kind: "num", text: m[1], value: Number(m[1]) })
    else if (m[2] !== undefined) out.push({ kind: "word", text: m[2] })
    else out.push({ kind: "sep", text: m[3] })
  }
  // A single letter a–h run straight on to a number is that number's letter
  // ("4a", "012b") — unless more letters follow ("1Sam", "12abc").
  for (let i = 0; i < out.length - 1; i++) {
    const t = out[i]
    const next = out[i + 1]
    if (t.kind === "num" && next.kind === "word" && /^[a-h]$/i.test(next.text)) {
      t.letter = next.text.toLowerCase()
      out.splice(i + 1, 1)
    }
  }
  return out
}

/** Index of the next token that is not a separator, from `i`. */
function nextSignificant(toks: Tok[], i: number): number {
  let j = i
  while (j < toks.length && toks[j].kind === "sep") j++
  return j
}

interface BookHit { code: string; fromProject: boolean; start: number; end: number; beforeNumber: boolean }

/**
 * Every place a book is named: one to three words ("Song of Songs"), a digit
 * and a word ("1 Sam", "1Sam"), or a code. Weak short forms ("Ps", "可") only
 * count right before a number.
 */
function findBooks(toks: Tok[], index: BookNameIndex): BookHit[] {
  const hits: BookHit[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.kind === "sep") continue
    let best: BookHit | null = null
    // Up to four significant tokens: "1", "Sam" / "Song", "of", "Songs".
    let text = ""
    let j = i
    for (let n = 0; n < 4 && j < toks.length; n++) {
      const tok = toks[j]
      if (tok.kind === "sep") { j++; n--; continue }
      if (tok.kind === "num" && (n > 0 || tok.value > 3 || tok.letter)) break
      text += (text && tok.kind === "word" && /\p{L}$/u.test(text) ? " " : "") + tok.text
      const after = nextSignificant(toks, j + 1)
      const beforeNumber = after < toks.length && toks[after].kind === "num"
      // A lone digit is never a book on its own.
      if (!(tok.kind === "num" && n === 0)) {
        const found = index.lookup(text, beforeNumber)
        if (found) best = { ...found, start: i, end: j, beforeNumber }
      }
      j++
    }
    if (best) {
      hits.push(best)
      i = best.end
    }
  }
  return hits
}

/**
 * Read one name. `index` holds the built-in book names plus the project's own.
 */
export function readName(fileName: string, index: BookNameIndex): NameReading {
  const stem = nameStem(fileName)
  const toks = tokenize(stem)
  const hits = findBooks(toks, index)
  // The book is the one the reference follows; failing that, the first one.
  const hit = hits.find((h) => h.beforeNumber) ?? hits[0] ?? null

  const numbers: NameNumber[] = []
  const words: string[] = []
  let partWord: NameReading["partWord"] = null
  let pendingMarker: NumberMarker | undefined
  let pendingSep = ""
  let started = false
  let stopped = false
  const startAt = hit ? hit.end + 1 : 0
  let unknownBookWord: string | null = null

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (hit && i >= hit.start && i <= hit.end) continue
    if (i < startAt) {
      // Before the book: a book or track number ("01_GEN"), or other words.
      if (t.kind === "word" && !NOISE.has(t.text.toLowerCase())) words.push(t.text)
      continue
    }
    if (t.kind === "sep") {
      pendingSep += t.text
      continue
    }
    if (t.kind === "word") {
      const w = t.text.toLowerCase()
      const marker = MARKERS.get(w)
      const rank = PART_WORDS.get(w)
      const last = numbers[numbers.length - 1]
      // Chinese says what a number is AFTER it: "3章" is chapter 3.
      if (marker && POSTFIX_MARKERS.has(w)) {
        if (last && !last.marker) last.marker = marker
        pendingSep = ""
        continue
      }
      // "Genesis 1-1 b": a lone letter after the numbers is the last one's.
      if (started && !stopped && last && !last.letter && /^[a-h]$/.test(w)) {
        last.letter = w
        pendingSep = ""
        continue
      }
      if (marker) {
        pendingMarker = marker
        pendingSep = ""
        continue
      }
      if (rank != null && started) {
        partWord = { rank, word: t.text }
        pendingSep = ""
        continue
      }
      if (NOISE.has(w)) continue
      if (/^(to|through|thru|至|到)$/u.test(w)) {
        pendingSep += ` ${w} `
        continue
      }
      // An ordinary word after the numbers ends the reference: "Genesis 1-1
      // ENGESV 2023" must not read 2023 as a part.
      if (started) stopped = true
      if (!hit && !started) {
        const after = nextSignificant(toks, i + 1)
        if (after < toks.length && toks[after].kind === "num" && unknownBookWord === null) unknownBookWord = t.text
      }
      words.push(t.text)
      pendingSep = ""
      continue
    }
    // A number.
    if (stopped) continue
    const sep = pendingSep.trim().length > 0 ? pendingSep.trim() : pendingSep.length > 0 ? " " : ""
    numbers.push({
      value: t.value,
      sepBefore: started ? sep : "",
      ...(pendingMarker ? { marker: pendingMarker } : {}),
      ...(t.letter ? { letter: t.letter } : {}),
    })
    started = true
    pendingMarker = undefined
    pendingSep = ""
  }

  return {
    stem,
    book: hit ? { code: hit.code, fromProject: hit.fromProject } : null,
    numbers,
    partWord,
    words,
    unknownBookWord: hit ? null : unknownBookWord,
  }
}

/** The folders a file sits in, innermost first, from its relative path. */
export function folderSegments(relativePath: string): string[] {
  const parts = relativePath.split(/[\\/]/).filter(Boolean)
  return parts.slice(0, -1).reverse()
}

/** Natural order: "2" before "10", case and accents ignored. */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare
