// Canonical Bible book order — OT (Protestant) followed by NT. The index in
// this list is the sort ordinal used by the sidebar (#32) and any other UI
// that wants books in their traditional reading order rather than alphabetic.
const CANONICAL_ORDER: ReadonlyArray<readonly [code: string, name: string]> = [
  ["GEN", "Genesis"], ["EXO", "Exodus"], ["LEV", "Leviticus"], ["NUM", "Numbers"], ["DEU", "Deuteronomy"],
  ["JOS", "Joshua"], ["JDG", "Judges"], ["RUT", "Ruth"],
  ["1SA", "1 Samuel"], ["2SA", "2 Samuel"],
  ["1KI", "1 Kings"], ["2KI", "2 Kings"],
  ["1CH", "1 Chronicles"], ["2CH", "2 Chronicles"],
  ["EZR", "Ezra"], ["NEH", "Nehemiah"], ["EST", "Esther"], ["JOB", "Job"], ["PSA", "Psalms"],
  ["PRO", "Proverbs"], ["ECC", "Ecclesiastes"], ["SNG", "Song of Songs"],
  ["ISA", "Isaiah"], ["JER", "Jeremiah"], ["LAM", "Lamentations"], ["EZK", "Ezekiel"],
  ["DAN", "Daniel"], ["HOS", "Hosea"], ["JOL", "Joel"], ["AMO", "Amos"], ["OBA", "Obadiah"],
  ["JON", "Jonah"], ["MIC", "Micah"], ["NAM", "Nahum"], ["HAB", "Habakkuk"], ["ZEP", "Zephaniah"],
  ["HAG", "Haggai"], ["ZEC", "Zechariah"], ["MAL", "Malachi"],
  ["MAT", "Matthew"], ["MRK", "Mark"], ["LUK", "Luke"], ["JHN", "John"], ["ACT", "Acts"],
  ["ROM", "Romans"], ["1CO", "1 Corinthians"], ["2CO", "2 Corinthians"],
  ["GAL", "Galatians"], ["EPH", "Ephesians"], ["PHP", "Philippians"], ["COL", "Colossians"],
  ["1TH", "1 Thessalonians"], ["2TH", "2 Thessalonians"],
  ["1TI", "1 Timothy"], ["2TI", "2 Timothy"], ["TIT", "Titus"], ["PHM", "Philemon"],
  ["HEB", "Hebrews"], ["JAS", "James"], ["1PE", "1 Peter"], ["2PE", "2 Peter"],
  ["1JN", "1 John"], ["2JN", "2 John"], ["3JN", "3 John"], ["JUD", "Jude"], ["REV", "Revelation"],
]

const NAMES: Record<string, string> = Object.fromEntries(CANONICAL_ORDER)

// Lookup both directions (code→ordinal, name→ordinal) so the sort helper can
// handle files whose name was rewritten by file-labeling and files that still
// carry the raw USFM code.
const ORDINAL_BY_CODE = new Map<string, number>()
const ORDINAL_BY_NAME = new Map<string, number>()
CANONICAL_ORDER.forEach(([code, name], idx) => {
  ORDINAL_BY_CODE.set(code, idx)
  ORDINAL_BY_NAME.set(name.toLowerCase(), idx)
})

export function getBookName(code: string): string | undefined {
  return NAMES[(code || "").toUpperCase()]
}

export function isKnownBookCode(code: string): boolean {
  return (code || "").toUpperCase() in NAMES
}

/** Canonical sort ordinal for a Bible book referenced by either its 3-letter
 *  USFM code or its friendly display name. Returns -1 when the value isn't a
 *  known book — callers should treat that as "sort after all known books". */
export function getBookOrdinal(codeOrName: string): number {
  if (!codeOrName) return -1
  const upper = codeOrName.toUpperCase()
  const byCode = ORDINAL_BY_CODE.get(upper)
  if (byCode !== undefined) return byCode
  const byName = ORDINAL_BY_NAME.get(codeOrName.toLowerCase())
  return byName !== undefined ? byName : -1
}

/**
 * `Array#sort` comparator that orders book/file display names by canonical
 * Bible reading order (Genesis → Revelation). Names that don't resolve to a
 * known book sort AFTER all known books, alphabetically among themselves.
 * Use anywhere books should read like a Bible rather than A–Z — the sidebar
 * corpus groups and the book-assignment pickers both share this so ordering
 * stays consistent across surfaces (AQU-582).
 */
export function compareByCanonicalBookOrder(a: string, b: string): number {
  const oa = getBookOrdinal(a)
  const ob = getBookOrdinal(b)
  if (oa >= 0 || ob >= 0) {
    if (oa < 0) return 1
    if (ob < 0) return -1
    if (oa !== ob) return oa - ob
  }
  return a.localeCompare(b)
}
