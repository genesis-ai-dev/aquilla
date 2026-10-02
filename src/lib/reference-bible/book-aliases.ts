// AQU-1573: English book names and abbreviations for the in-prose reference
// finder. Sermons write "Isaiah 40:25", "Is 40:25", "1 Cor. 13:4", "First John
// 4:8", "II Kings 2:11", "Song of Songs 2:4" — all of them have to land on one
// USFM code. Display names reuse the file-labeling table so labels match the
// rest of the app.
//
// No path aliases: auth-worker imports this file too (see types.ts).

import { getBookName } from "../file-labeling/bible-book-names"

/** Books with no ordinal prefix: code → names, longest written form first. */
const PLAIN: ReadonlyArray<readonly [code: string, names: readonly string[]]> = [
  ["GEN", ["Genesis", "Gen", "Gn", "Ge"]],
  ["EXO", ["Exodus", "Exod", "Exo", "Ex"]],
  ["LEV", ["Leviticus", "Lev", "Lv"]],
  ["NUM", ["Numbers", "Numb", "Num", "Nm", "Nu"]],
  ["DEU", ["Deuteronomy", "Deut", "Deu", "Dt"]],
  ["JOS", ["Joshua", "Josh", "Jos", "Jsh"]],
  ["JDG", ["Judges", "Judg", "Jdgs", "Jdg", "Jg"]],
  ["RUT", ["Ruth", "Rth", "Rut", "Ru"]],
  ["EZR", ["Ezra", "Ezr"]],
  ["NEH", ["Nehemiah", "Neh", "Ne"]],
  ["EST", ["Esther", "Esth", "Est", "Es"]],
  ["JOB", ["Job", "Jb"]],
  ["PSA", ["Psalms", "Psalm", "Pslm", "Psa", "Psm", "Pss", "Ps"]],
  ["PRO", ["Proverbs", "Prov", "Pro", "Prv", "Pr"]],
  ["ECC", ["Ecclesiastes", "Qoheleth", "Eccles", "Eccl", "Ecc", "Ec"]],
  ["SNG", ["Song of Solomon", "Song of Songs", "Song of Sol", "Canticles", "Cant", "Song", "SoS", "Sg"]],
  ["ISA", ["Isaiah", "Isa", "Is"]],
  ["JER", ["Jeremiah", "Jer", "Je", "Jr"]],
  ["LAM", ["Lamentations", "Lam", "La"]],
  ["EZK", ["Ezekiel", "Ezek", "Eze", "Ezk"]],
  ["DAN", ["Daniel", "Dan", "Da", "Dn"]],
  ["HOS", ["Hosea", "Hos", "Ho"]],
  ["JOL", ["Joel", "Jl"]],
  ["AMO", ["Amos", "Am"]],
  ["OBA", ["Obadiah", "Obad", "Ob"]],
  ["JON", ["Jonah", "Jnh", "Jon"]],
  ["MIC", ["Micah", "Mic", "Mc"]],
  ["NAM", ["Nahum", "Nah", "Na"]],
  ["HAB", ["Habakkuk", "Hab", "Hb"]],
  ["ZEP", ["Zephaniah", "Zeph", "Zep", "Zp"]],
  ["HAG", ["Haggai", "Hag", "Hg"]],
  ["ZEC", ["Zechariah", "Zech", "Zec", "Zc"]],
  ["MAL", ["Malachi", "Mal", "Ml"]],
  ["MAT", ["Matthew", "Matt", "Mat", "Mt"]],
  ["MRK", ["Mark", "Mrk", "Mk", "Mr"]],
  ["LUK", ["Luke", "Luk", "Lk"]],
  ["JHN", ["John", "Joh", "Jhn", "Jn"]],
  ["ACT", ["Acts", "Act", "Ac"]],
  ["ROM", ["Romans", "Rom", "Ro", "Rm"]],
  ["GAL", ["Galatians", "Gal", "Ga"]],
  ["EPH", ["Ephesians", "Ephes", "Eph"]],
  // "Phil" is Philippians and "Philem" is Philemon, the usual convention.
  ["PHP", ["Philippians", "Phil", "Php", "Pp"]],
  ["COL", ["Colossians", "Col"]],
  ["TIT", ["Titus", "Tit"]],
  ["PHM", ["Philemon", "Philem", "Phm", "Pm"]],
  ["HEB", ["Hebrews", "Heb"]],
  ["JAS", ["James", "Jas", "Jm"]],
  ["JUD", ["Jude", "Jud", "Jd"]],
  ["REV", ["Revelations", "Revelation", "Rev", "Rv", "Re"]],
]

/** Books that take an ordinal: base names → code per ordinal. */
const ORDINAL: ReadonlyArray<readonly [codes: Readonly<Record<number, string>>, names: readonly string[]]> = [
  [{ 1: "1SA", 2: "2SA" }, ["Samuel", "Sam", "Sa", "Sm"]],
  [{ 1: "1KI", 2: "2KI" }, ["Kings", "Kgs", "Kin", "Ki", "Kg"]],
  [{ 1: "1CH", 2: "2CH" }, ["Chronicles", "Chron", "Chr", "Ch"]],
  [{ 1: "1CO", 2: "2CO" }, ["Corinthians", "Cor", "Co"]],
  [{ 1: "1TH", 2: "2TH" }, ["Thessalonians", "Thess", "Thes", "Th"]],
  [{ 1: "1TI", 2: "2TI" }, ["Timothy", "Tim", "Ti", "Tm"]],
  [{ 1: "1PE", 2: "2PE" }, ["Peter", "Pet", "Pe", "Pt"]],
  [{ 1: "1JN", 2: "2JN", 3: "3JN" }, ["John", "Joh", "Jhn", "Jn"]],
]

/** One-chapter books: a bare number after the name is a verse ("Jude 3"). */
const SINGLE_CHAPTER = new Set(["OBA", "PHM", "2JN", "3JN", "JUD"])

/**
 * Abbreviations that are also everyday English words at the start of a
 * sentence ("Is 5:30 ok?", "Am 6.5 enough?"). The finder accepts them only in
 * the unambiguous `c:v` form.
 */
export const WORD_LIKE_ALIASES = new Set(["is", "am"])

function key(name: string): string {
  return name.toLowerCase().replace(/[.\s]+/g, "")
}

const PLAIN_BY_KEY = new Map<string, string>()
for (const [code, names] of PLAIN) for (const n of names) PLAIN_BY_KEY.set(key(n), code)

const ORDINAL_BY_KEY = new Map<string, Readonly<Record<number, string>>>()
for (const [codes, names] of ORDINAL) for (const n of names) ORDINAL_BY_KEY.set(key(n), codes)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const ALL_NAMES = [...new Set([...PLAIN, ...ORDINAL].flatMap(([, names]) => names))]
  // Longest first so "Song of Songs" wins over "Song" and "Philem" over "Phil".
  .sort((a, b) => b.length - a.length)

/**
 * Regex source for a book name with an optional ordinal. Group 1 is the
 * ordinal, group 2 the name. Used with the `iu` flags; the finder separately
 * requires the name to start with a capital letter.
 */
export const BOOK_PATTERN =
  "(?<![\\p{L}\\p{N}])" +
  "((?:[123](?:st|nd|rd)?\\s*)|(?:(?:III|II|I|First|Second|Third)\\s+))?" +
  `(${ALL_NAMES.map((n) => escapeRe(n).replace(/ /g, "\\s+")).join("|")})` +
  "(?![\\p{L}])\\.?"

function ordinalNumber(raw: string): number | null {
  const t = raw.trim().toLowerCase()
  if (/^1(st)?$/.test(t) || t === "i" || t === "first") return 1
  if (/^2(nd)?$/.test(t) || t === "ii" || t === "second") return 2
  if (/^3(rd)?$/.test(t) || t === "iii" || t === "third") return 3
  return null
}

/** USFM code for a matched ordinal + name, or null when the pair is not a book. */
export function resolveBook(ordinal: string | undefined, name: string): string | null {
  const k = key(name)
  if (ordinal) {
    const n = ordinalNumber(ordinal)
    const codes = ORDINAL_BY_KEY.get(k)
    return n !== null && codes ? (codes[n] ?? null) : null
  }
  return PLAIN_BY_KEY.get(k) ?? null
}

export function isSingleChapterBook(code: string): boolean {
  return SINGLE_CHAPTER.has(code)
}

export function isWordLikeAlias(name: string): boolean {
  return WORD_LIKE_ALIASES.has(key(name))
}

/** Reader name for a book: "Isaiah", "1 Corinthians"; one psalm reads "Psalm". */
export function bookLabel(code: string, singleChapterRef = false): string {
  if (code === "PSA" && singleChapterRef) return "Psalm"
  return getBookName(code) ?? code
}
