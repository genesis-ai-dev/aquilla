/**
 * Bible book names as Biblica's InDesign templates spell them, and the matcher
 * that reads one off the front of a heading.
 *
 * Every Biblica edition names books in running English rather than in codes:
 * a Treasure Hunt fact heading says "Genesis 2:8−15", a Reach4Life book
 * introduction is titled "1 Corinthians". Both importers need the same
 * name → USFM-code lookup, and both need it to be one table, because a name
 * missing from one copy is a book that silently loses its navigation.
 */

const BOOK_NAMES: ReadonlyArray<readonly [name: string, code: string]> = [
  ["Genesis", "GEN"], ["Exodus", "EXO"], ["Leviticus", "LEV"], ["Numbers", "NUM"],
  ["Deuteronomy", "DEU"], ["Joshua", "JOS"], ["Judges", "JDG"], ["Ruth", "RUT"],
  ["1 Samuel", "1SA"], ["2 Samuel", "2SA"], ["1 Kings", "1KI"], ["2 Kings", "2KI"],
  ["1 Chronicles", "1CH"], ["2 Chronicles", "2CH"], ["Ezra", "EZR"], ["Nehemiah", "NEH"],
  ["Esther", "EST"], ["Job", "JOB"], ["Psalms", "PSA"], ["Psalm", "PSA"],
  ["Proverbs", "PRO"], ["Ecclesiastes", "ECC"], ["Song of Songs", "SNG"],
  ["Song of Solomon", "SNG"], ["Isaiah", "ISA"], ["Jeremiah", "JER"],
  ["Lamentations", "LAM"], ["Ezekiel", "EZK"], ["Daniel", "DAN"], ["Hosea", "HOS"],
  ["Joel", "JOL"], ["Amos", "AMO"], ["Obadiah", "OBA"], ["Jonah", "JON"],
  ["Micah", "MIC"], ["Nahum", "NAM"], ["Habakkuk", "HAB"], ["Zephaniah", "ZEP"],
  ["Haggai", "HAG"], ["Zechariah", "ZEC"], ["Malachi", "MAL"],
  ["Matthew", "MAT"], ["Mark", "MRK"], ["Luke", "LUK"], ["John", "JHN"],
  ["Acts", "ACT"], ["Romans", "ROM"], ["1 Corinthians", "1CO"], ["2 Corinthians", "2CO"],
  ["Galatians", "GAL"], ["Ephesians", "EPH"], ["Philippians", "PHP"], ["Colossians", "COL"],
  ["1 Thessalonians", "1TH"], ["2 Thessalonians", "2TH"], ["1 Timothy", "1TI"],
  ["2 Timothy", "2TI"], ["Titus", "TIT"], ["Philemon", "PHM"], ["Hebrews", "HEB"],
  ["James", "JAS"], ["1 Peter", "1PE"], ["2 Peter", "2PE"], ["1 John", "1JN"],
  ["2 John", "2JN"], ["3 John", "3JN"], ["Jude", "JUD"], ["Revelation", "REV"],
]

/**
 * Longest-first so a prefix match cannot stop at the shorter of two names that
 * share an opening ("John" inside "1 John", "Song" inside "Song of Songs").
 */
const BOOK_NAMES_BY_LENGTH = [...BOOK_NAMES].sort((a, b) => b[0].length - a[0].length)

export interface BiblicaBookNameMatch {
  /** The name as it was spelled in the text, so callers can skip past it. */
  readonly name: string
  /** USFM code for that book. */
  readonly bookCode: string
}

/**
 * The book name `text` opens with, if it opens with one.
 *
 * `text` is matched from its first character: these headings are references
 * ("Genesis 2:8−15") or titles ("1 Corinthians"), never sentences that mention
 * a book in passing, so a name found mid-string would be a false positive.
 */
export function matchLeadingBookName(text: string): BiblicaBookNameMatch | undefined {
  const normalized = text.replace(/\s+/g, " ").trim()
  const entry = BOOK_NAMES_BY_LENGTH.find(([name]) => startsWithBookName(normalized, name))
  return entry ? { name: entry[0], bookCode: entry[1] } : undefined
}

/**
 * A book name only matches when the text does not continue into another word —
 * "Jude" must not match "Judea", and "John" must not swallow "Johnson".
 */
function startsWithBookName(text: string, name: string): boolean {
  if (!text.startsWith(name)) return false
  const next = text[name.length]
  return next === undefined || !/[\p{L}\p{N}]/u.test(next)
}
