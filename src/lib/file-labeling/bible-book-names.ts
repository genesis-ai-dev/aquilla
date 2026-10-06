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

/** How a book name is compared: case, spaces and periods don't count, so
 *  "1 Samuel", "1samuel" and "Song of Songs" all find their book. */
const nameKey = (value: string) => value.toLowerCase().replace(/[\s.]+/g, "")

// Spellings people use that aren't the table's own names (AQU-1375).
const NAME_ALIASES: ReadonlyArray<readonly [name: string, code: string]> = [
  ["Psalm", "PSA"], ["Song of Solomon", "SNG"],
]

const CODE_BY_NAME_KEY = new Map<string, string>([
  ...CANONICAL_ORDER.map(([code, name]) => [nameKey(name), code] as const),
  ...NAME_ALIASES.map(([name, code]) => [nameKey(name), code] as const),
])

/** The USFM code for a book written either as its code in any case ("gen")
 *  or as its English name ("Genesis", "1 Samuel", "Psalm"). Undefined when
 *  neither — a spreadsheet's reference column is the main caller, so other
 *  languages' names and abbreviations such as "Gen." are not guessed at. */
export function bookCodeFromName(value: string): string | undefined {
  const trimmed = (value || "").trim()
  if (isKnownBookCode(trimmed)) return trimmed.toUpperCase()
  return CODE_BY_NAME_KEY.get(nameKey(trimmed))
}

/**
 * The book a file name names outright: its leading words are a book's code
 * or English name ("JON-source", "Judges", "1 Samuel - draft", "Song of
 * Songs"), optionally with a chapter number run on ("GEN1-source",
 * "Mark16"), or it is a Paratext book file ("41MRKENG.SFM"). Undefined when
 * the name only happens to start or end with three letters that are a code.
 *
 * AQU-1365 review: the looser rule below read "Judges" as JUD (Jude, the
 * first three letters) and found nothing in "Mark", "John" or "Joel". The
 * translation import trusts this to pick a file and to offer "Update
 * Judges's source text", so a full name has to win over a prefix.
 */
export function bookCodeFromFileNameStrict(name: string): string | undefined {
  const dot = name.lastIndexOf(".")
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim()
  const tokens = stem.split(/[\s_\-.,()]+/).filter(Boolean)
  for (let count = Math.min(tokens.length, 3); count >= 1; count--) {
    const code = bookCodeFromName(tokens.slice(0, count).join(" "))
    if (code) return code
  }
  const chapterRunOn = /^(.*?[A-Za-z])\d+$/.exec(tokens[0] ?? "")?.[1]
  if (chapterRunOn) {
    const code = bookCodeFromName(chapterRunOn)
    if (code) return code
  }
  const paratext = /^\d{2}([1-3A-Za-z][A-Za-z0-9]{2})[A-Za-z0-9]*$/.exec(stem)?.[1]
  if (paratext && isKnownBookCode(paratext)) return paratext.toUpperCase()
  return undefined
}

/**
 * The USFM book code a file name carries, if any. Strips the extension, then
 * reads a name that names its book outright (`bookCodeFromFileNameStrict`),
 * then tries a 3-character run at the end of the stem (handles "40-MAT") and
 * at the front (handles "gen1-draft"); a candidate is accepted only when it
 * is a known book code. This is the file-labeling detector's rule, shared so
 * the sidebar can group migrated projects whose files carry no `bookCode`
 * column and no `corpusMarker` (AQU-1084): those files are named by bare
 * code ("1CH", "MAT"), which is all this needs.
 */
export function bookCodeFromFileName(name: string): string | undefined {
  const strict = bookCodeFromFileNameStrict(name)
  if (strict) return strict
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const endCandidate = stem.match(/([A-Za-z0-9]{3})$/)?.[1]
  const frontCandidate = stem.match(/^([A-Za-z0-9]{3})/)?.[1]
  if (endCandidate && isKnownBookCode(endCandidate)) return endCandidate.toUpperCase()
  if (frontCandidate && isKnownBookCode(frontCandidate)) return frontCandidate.toUpperCase()
  return undefined
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
