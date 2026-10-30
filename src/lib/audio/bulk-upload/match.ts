// AQU-981: decide which line each recording in a bulk upload lands on.
//
// THE RULE, in the words the preview's (i) uses:
//
//   1. A name that says a book, a chapter and a verse goes to that verse
//      ("Genesis 1-1", "Gen 1.1", "1Sam_3_4", "GEN_001_001", "创世记1章1节"),
//      in any spelling the app knows or the project itself uses for the book.
//      With no book in the name, the folder's name is read for one.
//   2. Inside one file, numbers alone are enough: in a Bible book "1-1" or
//      "001_001" is chapter 1 verse 1; in any other file "012", "line 12" or
//      "part_003" is that line, counted from the top. A number alone in a
//      Bible book ("012") is a chapter or a verse by how many such files the
//      folder holds (LONE_NUMBER_TOLERANCE). A number marked as a line in a
//      Bible book ("MAT_1_LN619") is the verse's place counted from the
//      book's first verse, by the book's own numbering; a verse number beside
//      it must agree, or the file is listed with both.
//   3. "Genesis 1:1-3" or "1-1-3" is one recording for verses 1 to 3; a name
//      with a chapter and no verse is one recording for the whole chapter.
//   4. A verse in several files ("1-1a", "1-1 part 2", "1-1_2", "beginning",
//      "end") lands as the pieces of one recording, in that order. Several
//      files for one line that are not its parts all land as takes; the most
//      recently modified plays (numbered takes: the highest).
//   5. When no file in a folder has a usable number, the files go to the
//      lines in folder order — the names sorted so 2 comes before 10.
//   6. Anything else is listed with the reason, and is not uploaded.
//
// Pure: nothing here touches the network, React or the DOM, so every rule is
// pinned by match.test.ts.

import { BOOK_CODES, BookNameIndex, englishBookName } from "./book-names"
import { folderSegments, isRangeSep, naturalCompare, readName, type NameNumber, type NameReading } from "./read-name"

/** Folder order: the path without its extension, sorted naturally — so
 *  "Genesis 1-1" comes before "Genesis 1-1 copy", and 2 before 10. */
export function compareFolderOrder(a: string, b: string): number {
  const stem = (p: string) => p.replace(/\.[A-Za-z][A-Za-z0-9]{1,4}$/, "")
  return naturalCompare(stem(a), stem(b)) || naturalCompare(a, b)
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface BulkInputFile {
  name: string
  /** Its path inside the chosen folder ("Genesis/Genesis 1-1.mp3"); the name
   *  alone for files picked one by one. */
  path: string
  size: number
  type: string
  /** File.lastModified (ms). Of several files for one line, the most recent
   *  is the take that plays (Sam, Oct 29). */
  lastModified?: number
}

export interface TargetLine {
  cellId: string
  /** Canonical scripture ref ("GEN 1:3", "GEN 1:1-2"), when the line has one. */
  ref: string | null
  /** A short preview of what the line says. */
  text: string
  /** A heading, book title or chapter label — never given a recording by
   *  number or by order, though the person may choose one by hand. */
  structural: boolean
  /** The line already has a recording that plays in this language. */
  hasRecording: boolean
}

export interface TargetFile {
  fileId: string
  name: string
  /** USFM code for a Bible book; null for every other file. */
  bookCode: string | null
  /** Every visible line, in the order the editor shows them. */
  lines: TargetLine[]
  /** Its lines have times: a subtitle or film file. One recording can't cover
   *  several of its lines (Sam, Oct 29), so a range is refused here. */
  timed?: boolean
}

/** A project file as the project-wide upload sees it before its lines load. */
export interface ProjectFileInfo {
  fileId: string
  name: string
  bookCode: string | null
}

export type MatchScope = { kind: "file"; fileId: string } | { kind: "project" }

// ── Outputs ──────────────────────────────────────────────────────────────────

export type MatchMethod = "name" | "number" | "order"

/** Why a file will not be uploaded. Rendered as a sentence by the preview. */
export type UnmatchedReason =
  | { code: "notAudio" }
  | { code: "unplayableFormat"; ext: string }
  | { code: "systemFile" }
  | { code: "empty" }
  | { code: "tooLarge"; mb: number; limitMb: number }
  | { code: "noBook" }
  | { code: "bookNotInProject"; book: string }
  | { code: "otherBook"; book: string; fileName: string }
  | { code: "noSuchChapter"; book: string; chapter: number }
  | { code: "noSuchVerse"; ref: string }
  | { code: "noVerseChapter"; verse: number }
  | { code: "noSuchLine"; line: number; count: number }
  | { code: "noNumber" }
  | { code: "tooManyNumbers" }
  | { code: "pastLastLine"; count: number }
  | { code: "beforeFirstLine" }
  | { code: "duplicate"; target: string; other: string }
  | { code: "rangeOnTimedFile" }
  | { code: "rangeBackwards"; from: string; to: string }
  | { code: "chapterOrVerse"; count: number; book: string; chapters: number; verses: number; lengthMs?: number }
  | { code: "bookVerseDisagree"; count: number; verse: number; ref: string }
  | { code: "noSuchBookVerse"; count: number; verses: number; book: string }
  | { code: "skipped" }

export interface PartInfo {
  /** Sort key within the verse: letter a = 1, "part 2" = 2, "end" = 3. */
  rank: number
  /** As written: "a", "2", "end". */
  label: string
  /** The verse's own part of a bridged line ("19:1" on "19:1-2"), not a part
   *  the name gave. */
  bridged?: boolean
}

export interface Assignment {
  /** Index into the input file list. */
  index: number
  method?: MatchMethod
  fileId?: string
  /** One line, or every line a range covers, in order. */
  cellIds?: string[]
  part?: PartInfo
  /** "take 2": several takes of one line upload in this order, the last plays. */
  take?: number
  /** Order-based files share a run (their folder and file) that moves as one. */
  orderRun?: string
  reason?: UnmatchedReason
  /** What the name was read as, for the row ("Genesis 1:3", "line 12"). */
  read?: string
  /** The book or chapter came from the folder's name. */
  fromFolder?: string
  /** The person chose this line in the preview. */
  chosen?: boolean
  /** A number alone the count couldn't place, placed by the recordings'
   *  length instead: as a chapter or a verse, and the folder's median (ms). */
  byLength?: { as: "chapter" | "verse"; ms: number }
}

// ── Reading every name ───────────────────────────────────────────────────────

/** What one recording's name and folders say, before any line is looked up. */
export interface ReadRecording {
  index: number
  file: BulkInputFile
  reading: NameReading
  /** Set when the file is refused before matching (not audio, too big…). */
  refused?: UnmatchedReason
  /** The project file it goes to, when known from its name, folder or scope. */
  targetFileId?: string
  /** No file could be decided (project scope). */
  targetReason?: UnmatchedReason
  folderBook?: { code: string; segment: string }
  folderChapter?: { chapter: number; segment: string }
  /** True when the book was read from the number in front ("01_001_001"). */
  bookFromNumber?: boolean
  /** The folder the file sits in — files in one folder share a naming scheme. */
  folderKey: string
}

const AUDIO_EXTS = new Set(["wav", "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "webm", "flac"])
/** Audio the one-file upload refuses (attach-file.ts KNOWN_AUDIO_EXTS) and
 *  most browsers can't play: uploaded, each would sit on its line as a take
 *  that never plays. Refused here too, whatever type the file declares. */
const UNPLAYABLE_EXTS = new Set(["wma", "aif", "aiff", "amr", "3gp", "caf"])
const SYSTEM_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", "icon\r"])

function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** Refuse what can never become a recording, before reading its name. */
export function precheckFile(file: BulkInputFile, maxBytes: number): UnmatchedReason | null {
  const lower = file.name.toLowerCase()
  if (lower.startsWith("._") || SYSTEM_NAMES.has(lower) || (lower.startsWith(".") && !AUDIO_EXTS.has(extOf(lower)))) {
    return { code: "systemFile" }
  }
  const ext = extOf(file.name)
  if (UNPLAYABLE_EXTS.has(ext)) return { code: "unplayableFormat", ext }
  const declaredAudio = file.type.toLowerCase().startsWith("audio/")
  if (!declaredAudio && !AUDIO_EXTS.has(extOf(file.name))) return { code: "notAudio" }
  if (file.size === 0) return { code: "empty" }
  if (file.size > maxBytes) {
    return { code: "tooLarge", mb: Math.round(file.size / (1024 * 1024)), limitMb: Math.round(maxBytes / (1024 * 1024)) }
  }
  return null
}

/** A project file name, compared the way a recording's name prefix is. */
function fileNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[\s._\-'’]+/gu, " ")
    .trim()
}

/** The book (and chapter) a folder's name gives, innermost folder first. */
function readFolders(path: string, index: BookNameIndex): Pick<ReadRecording, "folderBook" | "folderChapter"> {
  const out: Pick<ReadRecording, "folderBook" | "folderChapter"> = {}
  for (const segment of folderSegments(path)) {
    // A short made-up extension, so the name reader strips it and a dotted
    // folder ("Gen 3.1") keeps its numbers; a longer one stayed in the name as
    // a word, and a folder that is just "3" was never read as a chapter.
    const r = readName(`${segment}.dir`, index)
    if (r.book && !out.folderBook) {
      out.folderBook = { code: r.book.code, segment }
      const chapter = r.numbers.find((n) => n.marker === "chapter") ?? (r.numbers.length === 1 ? r.numbers[0] : undefined)
      if (chapter && !out.folderChapter) out.folderChapter = { chapter: chapter.value, segment }
      continue
    }
    if (!out.folderChapter && !out.folderBook) {
      // "Chapter 3", "ch03", "第3章", or a folder that is just "3".
      const marked = r.numbers.find((n) => n.marker === "chapter")
      const lone = r.numbers.length === 1 && r.words.length === 0 ? r.numbers[0] : undefined
      const chapter = marked ?? lone
      if (chapter) out.folderChapter = { chapter: chapter.value, segment }
    }
  }
  return out
}

/**
 * Book numbers in front of chapter and verse ("01_001_001"). OT numbers are
 * the same in every scheme; the NT is 40–66 in canonical order and 41–67 in
 * Paratext's, so the scheme that finds more of the project's books wins.
 */
function bookFromNumber(n: number, scheme: "canonical" | "paratext"): string | null {
  if (n >= 1 && n <= 39) return BOOK_CODES[n - 1] ?? null
  if (scheme === "canonical") return BOOK_CODES[n - 1] ?? null
  return n >= 41 && n <= 67 ? BOOK_CODES[n - 2] ?? null : null
}

export interface ReadOptions {
  scope: MatchScope
  index: BookNameIndex
  projectFiles: readonly ProjectFileInfo[]
  maxBytes: number
}

/**
 * Read every name and decide which project FILE each recording goes to. Line
 * lookups wait for `matchRecordings`: the project-wide upload loads only the
 * files named here.
 */
export function readRecordings(files: readonly BulkInputFile[], opts: ReadOptions): ReadRecording[] {
  const { scope, index, projectFiles, maxBytes } = opts
  const byBook = new Map<string, ProjectFileInfo[]>()
  for (const f of projectFiles) {
    if (!f.bookCode) continue
    const list = byBook.get(f.bookCode) ?? []
    list.push(f)
    byBook.set(f.bookCode, list)
  }
  const fileForBook = (code: string) => byBook.get(code)?.[0]
  const otherFiles = projectFiles
    .filter((f) => !f.bookCode)
    .map((f) => ({ f, key: fileNameKey(f.name) }))
    .filter((x) => x.key.length > 0)
    // Longest name first, so "Intro part 2" wins over "Intro".
    .sort((a, b) => b.key.length - a.key.length)

  const out: ReadRecording[] = files.map((file, i) => {
    const reading = readName(file.name, index)
    const folderKey = file.path.split(/[\\/]/).slice(0, -1).join("/")
    const base: ReadRecording = { index: i, file, reading, folderKey }
    const refused = precheckFile(file, maxBytes)
    if (refused) return { ...base, refused }
    const folders = readFolders(file.path, index)
    Object.assign(base, folders)

    if (scope.kind === "file") return { ...base, targetFileId: scope.fileId }

    const book = reading.book?.code ?? folders.folderBook?.code
    if (book) {
      const target = fileForBook(book)
      return target
        ? { ...base, targetFileId: target.fileId }
        : { ...base, targetReason: { code: "bookNotInProject", book: englishBookName(book) } }
    }
    // A file that is not a book, named at the front of the recording or as its folder.
    const stemKey = fileNameKey(reading.stem)
    const folderKeys = folderSegments(file.path).map(fileNameKey)
    const named = otherFiles.find(({ key }) =>
      folderKeys.includes(key) || stemKey === key || (stemKey.startsWith(`${key} `) && /\d/.test(stemKey.slice(key.length))),
    )
    if (named) return { ...base, targetFileId: named.f.fileId }
    return { ...base, targetReason: { code: "noBook" } }
  })

  // Project scope: numbers only, three of them — the first is a book number.
  if (scope.kind === "project") {
    const candidates = out.filter((r) => !r.refused && r.targetReason?.code === "noBook" && r.reading.numbers.length === 3 && !isRangeSep(r.reading.numbers[2].sepBefore))
    if (candidates.length > 0) {
      const score = (scheme: "canonical" | "paratext") =>
        candidates.filter((r) => {
          const code = bookFromNumber(r.reading.numbers[0].value, scheme)
          return code != null && fileForBook(code) != null
        }).length
      const scheme = score("paratext") > score("canonical") ? "paratext" : "canonical"
      for (const r of candidates) {
        const code = bookFromNumber(r.reading.numbers[0].value, scheme)
        const target = code ? fileForBook(code) : undefined
        if (!target) continue
        r.targetFileId = target.fileId
        r.targetReason = undefined
        r.bookFromNumber = true
        r.reading = { ...r.reading, numbers: r.reading.numbers.slice(1) }
      }
    }
  }
  return out
}

/** The project files a project-wide upload has to load lines for. */
export function targetsWanted(read: readonly ReadRecording[]): string[] {
  return [...new Set(read.flatMap((r) => (r.targetFileId && !r.refused ? [r.targetFileId] : [])))]
}

// ── Interpreting the numbers ─────────────────────────────────────────────────

/** What a name's numbers mean for one destination. */
type Wanted =
  | { kind: "verse"; chapter: number; verse: number; letter?: string }
  | { kind: "verseRange"; chapter: number; verse: number; toChapter: number; toVerse: number }
  | { kind: "chapter"; chapter: number }
  | { kind: "line"; line: number }
  | { kind: "bookVerse"; count: number; verse?: number }
  | { kind: "lineRange"; line: number; toLine: number }
  | { kind: "none" }
  | { kind: "error"; reason: UnmatchedReason }

interface Interpreted {
  wanted: Wanted
  part?: PartInfo
  take?: number
  /** The chapter came from the folder's name, not the file's. */
  folderChapter?: boolean
}

function partOf(reading: NameReading, extra?: NameNumber): PartInfo | undefined {
  if (extra) return { rank: extra.value, label: String(extra.value) }
  if (reading.partWord) return { rank: reading.partWord.rank, label: reading.partWord.word }
  return undefined
}

function letterPart(letter: string): PartInfo {
  return { rank: letter.charCodeAt(0) - 96, label: letter }
}

/** The numbers a book goes by in front of chapter and verse, in both schemes. */
function bookNumbers(code: string | null): number[] {
  const at = code ? BOOK_CODES.indexOf(code) : -1
  if (at < 0) return []
  return at < 39 ? [at + 1] : [at + 1, at + 2]
}

/**
 * Drop a number every file in the folder shares in the same place, when the
 * scheme has one number too many for it: "01_001_001", "01_001_002" … in a
 * Bible book (the book's own number), "LOTE_2023_012" in a document (a year).
 * Never the last one standing.
 *
 * In a Bible book the first number goes only when it can be the book's own:
 * no name says the book in words (then the first number is the chapter), the
 * three numbers are written alike ("01_001_001", not "1-4_1", a verse's
 * part), and it is this book's number in either scheme. "Genesis 1-4_1" and
 * "1-4_1" keep chapter 1.
 */
function pruneConstants(group: ReadRecording[], bible: boolean, bookCode: string | null): Map<number, NameNumber[]> {
  const out = new Map<number, NameNumber[]>()
  for (const r of group) out.set(r.index, r.reading.numbers.filter((n) => n.marker !== "take" && n.marker !== "part"))
  if (group.length < 3) return out
  const lists = group.map((r) => out.get(r.index)!)
  const k = lists[0]?.length ?? 0
  if (k < 2 || lists.some((l) => l.length !== k)) return out
  if (lists.some((l) => l.some((n) => n.marker))) return out
  const constant = (pos: number) => lists.every((l) => l[pos].value === lists[0][pos].value)
  if (bible) {
    const own = bookNumbers(bookCode)
    const bookNumber =
      k === 3 && constant(0) &&
      !group.some((r) => r.reading.book) &&
      !lists.some((l) => isRangeSep(l[2].sepBefore) || l[1].sepBefore !== l[2].sepBefore) &&
      (own.length === 0 || own.includes(lists[0][0].value))
    if (bookNumber) {
      for (const r of group) out.set(r.index, out.get(r.index)!.slice(1))
    }
    return out
  }
  const keep = Array.from({ length: k }, (_, pos) => !constant(pos))
  if (!keep.some(Boolean)) keep[k - 1] = true
  for (const r of group) out.set(r.index, out.get(r.index)!.filter((_, pos) => keep[pos]))
  return out
}

/**
 * Sam, Oct 29 (question 4): a number alone in a Bible book ("012.mp3", or
 * "Genesis/012.mp3" with the book from the folder) is decided by the count.
 * When the folder holds about as many such numbers as the book has chapters,
 * they are chapters; about as many as it has verses, they are verses, counted
 * from the top; when neither fits, or both do, the files are listed as
 * "can't tell" rather than guessed.
 *
 * "About as many" is within a tenth of the book's count, rounded down, either
 * side. Genesis (50 chapters, 1,533 verses): 45–55 files are chapters and
 * 1,380–1,686 are verses. Ruth (4 chapters, 85 verses): exactly 4 are chapters
 * and 77–93 are verses. A tenth leaves room in a big book for a few missing or
 * extra files (an intro, a retake under its own number); in a small book it
 * asks for every chapter, because there three files could as well be verses
 * 1–3 as chapters 1–3. The counts are the project's own lines: the chapters it
 * has, and its verse lines counted from the top.
 *
 * Distinct numbers are counted, not files, so a verse in two parts ("012a",
 * "012b") counts once. A name that says "chapter 12", a folder named for a
 * chapter ("Genesis 2/05.mp3"), or a book with one chapter decides it outright;
 * a book named in the name with one number ("Genesis 3") is still a chapter.
 */
export const LONE_NUMBER_TOLERANCE = 0.1

/**
 * Sam, Oct 29: when the count can't tell, the recordings' length decides, by
 * the folder's median. A median of a minute or more is chapters; half a minute
 * or less is verses; only in between does it stay "can't tell".
 *
 * The numbers behind it. Audio Bibles are read at about 150 to 170 words a
 * minute: the King James Version, 783,000 words, runs about 75 hours. An
 * average verse is 25 words (31,102 verses), about 10 seconds; the longest,
 * Esther 8:9, is 90 words, about 35 seconds. An average chapter is 660 words
 * (1,189 chapters), about 4 minutes. Many languages take more words or
 * syllables than English, up to about twice as long. So a folder of verses has
 * a median near 10 to 20 seconds, well under half a minute. A folder of
 * chapters has a median of several minutes: even the Psalms, the book of
 * shortest chapters, has a median psalm of about 16 verses, over two minutes.
 *
 * The median, not each file, because single files mislead. Psalm 117 is one
 * chapter of 33 words, about 12 to 25 seconds, shorter than many verses, and
 * Esther 8:9 is a verse longer than half a minute. One of either in a folder
 * leaves its median where the rest put it. A folder made only of the
 * shortest psalms (117, 131, 133, 134) would read as verses; the preview shows
 * it, and the person can change it.
 */
export const CHAPTER_MIN_MEDIAN_MS = 60_000
export const VERSE_MAX_MEDIAN_MS = 30_000

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Within the tolerance of `target`, either side. */
function closeTo(count: number, target: number): boolean {
  return target > 0 && Math.abs(count - target) <= Math.floor(target * LONE_NUMBER_TOLERANCE)
}

/** How a folder's lone numbers read in one Bible book. */
type LoneReading =
  | { as: "chapter"; byLengthMs?: number }
  | { as: "verse"; byLengthMs?: number }
  | { as: "unknown"; reason: UnmatchedReason }

/** The number, when a name in a Bible book holds one number and nothing says what it is. */
function loneNumber(r: ReadRecording, nums: readonly NameNumber[]): NameNumber | null {
  if (r.reading.book || r.bookFromNumber || r.folderChapter) return null
  return nums.length === 1 && !nums[0].marker ? nums[0] : null
}

function readLoneNumbers(
  fi: FileIndex,
  lone: ReadonlyMap<number, NameNumber>,
  singleChapter: boolean,
  lengths: ReadonlyMap<number, number> | undefined,
): LoneReading {
  if (singleChapter) return { as: "verse" }
  const count = new Set([...lone.values()].map((n) => n.value)).size
  const chapters = fi.chapters.size
  const verses = fi.content.length
  const asChapters = closeTo(count, chapters)
  const asVerses = closeTo(count, verses)
  if (asChapters !== asVerses) return asChapters ? { as: "chapter" } : { as: "verse" }
  // The count can't tell: the recordings' length decides, when it was read.
  const known = [...lone.keys()].flatMap((i) => {
    const ms = lengths?.get(i)
    return ms != null && ms > 0 ? [ms] : []
  })
  const reason: UnmatchedReason = { code: "chapterOrVerse", count, book: bookLabel(fi), chapters, verses }
  if (known.length === 0) return { as: "unknown", reason }
  const ms = median(known)
  if (ms >= CHAPTER_MIN_MEDIAN_MS) return { as: "chapter", byLengthMs: ms }
  if (ms <= VERSE_MAX_MEDIAN_MS) return { as: "verse", byLengthMs: ms }
  return { as: "unknown", reason: { ...reason, lengthMs: ms } }
}

/**
 * The files whose numbers neither count could place, and whose length hasn't
 * been read: the preview reads these files' lengths and matches again.
 */
export function needsLength(assignments: readonly Assignment[]): number[] {
  return assignments.flatMap((a) => (a.reason?.code === "chapterOrVerse" && a.reason.lengthMs == null ? [a.index] : []))
}

function interpretBible(r: ReadRecording, nums: NameNumber[], singleChapter: boolean, lone?: LoneReading): Interpreted {
  const reading = r.reading
  const take = reading.numbers.find((n) => n.marker === "take")?.value
  const markedPart = reading.numbers.find((n) => n.marker === "part")
  const lineMark = nums.find((n) => n.marker === "line")
  const chapterMark = nums.find((n) => n.marker === "chapter")
  const verseMark = nums.find((n) => n.marker === "verse")
  const plain = nums.filter((n) => !n.marker)
  const base: Pick<Interpreted, "take" | "folderChapter"> = { ...(take != null ? { take } : {}) }
  const withPart = (w: Wanted, extra?: NameNumber, letter?: string): Interpreted => ({
    wanted: w,
    ...base,
    ...(markedPart ? { part: partOf(reading, markedPart) } : extra ? { part: partOf(reading, extra) } : letter ? { part: letterPart(letter) } : reading.partWord ? { part: partOf(reading) } : {}),
  })
  if (lineMark && !chapterMark && !verseMark) {
    // ETEN, Oct 29: "MAT_1_LN619" — in a Bible book a line number is the
    // verse's place counted from the book's first verse, and a plain number
    // beside it is the verse within its chapter, which must agree.
    if (r.folderChapter == null && plain.length <= 1) {
      return withPart({ kind: "bookVerse", count: lineMark.value, ...(plain[0] ? { verse: plain[0].value } : {}) })
    }
    return withPart({ kind: "line", line: lineMark.value })
  }

  // A name that gives its own chapter and verse wins over a folder named for
  // a chapter: "Genesis 3/Genesis 1-1" is 1:1, and "Genesis 3/3-5" is 3:5. A
  // name without a book whose first number isn't the folder's chapter is
  // read inside it: "Genesis 3/1-4" is verses 1 to 4 of chapter 3.
  const folderChapter = r.folderChapter?.chapter
  const ownChapter = !chapterMark && !verseMark && plain.length >= 2 &&
    (reading.book != null || r.bookFromNumber === true || plain[0].value === folderChapter)
  let chapter = chapterMark?.value ?? (ownChapter ? undefined : folderChapter)
  if (chapterMark == null && !ownChapter && folderChapter != null) base.folderChapter = true
  let rest = plain
  if (chapter == null && verseMark) {
    if (plain.length > 0) { chapter = plain[0].value; rest = plain.slice(1) }
    else if (singleChapter) chapter = 1
    else return { wanted: { kind: "error", reason: { code: "noVerseChapter", verse: verseMark.value } }, ...base }
  }
  if (chapter == null) {
    if (plain.length === 0) return { wanted: { kind: "none" }, ...base }
    if (plain.length === 1) {
      // A book named in the name with one number is a chapter ("Genesis 3",
      // "Psalm 23"); a lone number with no book is a line, counted from the top.
      if (reading.book || r.bookFromNumber) {
        return singleChapter
          ? withPart({ kind: "verse", chapter: 1, verse: plain[0].value }, undefined, plain[0].letter)
          : withPart({ kind: "chapter", chapter: plain[0].value })
      }
      // No book in the name: the folder's count decides (LONE_NUMBER_TOLERANCE).
      if (lone?.as === "chapter") return withPart({ kind: "chapter", chapter: plain[0].value })
      if (lone?.as === "unknown") return { wanted: { kind: "error", reason: lone.reason }, ...base }
      return withPart({ kind: "line", line: plain[0].value }, undefined, plain[0].letter)
    }
    chapter = plain[0].value
    rest = plain.slice(1)
  }
  const verseNum = verseMark ?? rest[0]
  if (!verseNum) return withPart({ kind: "chapter", chapter })
  const after = verseMark ? rest : rest.slice(1)
  const next = after[0]
  if (next && isRangeSep(next.sepBefore)) {
    // "1:31-2:3" and "1-31-2-3" cross a chapter; "1:1-3" stays in it.
    if (after.length > 2) return { wanted: { kind: "error", reason: { code: "tooManyNumbers" } }, ...base }
    const cross = after[1]
    return {
      wanted: cross
        ? { kind: "verseRange", chapter, verse: verseNum.value, toChapter: next.value, toVerse: cross.value }
        : { kind: "verseRange", chapter, verse: verseNum.value, toChapter: chapter, toVerse: next.value },
      ...base,
    }
  }
  if (after.length > 1) return { wanted: { kind: "error", reason: { code: "tooManyNumbers" } }, ...base }
  return withPart({ kind: "verse", chapter, verse: verseNum.value, ...(verseNum.letter ? { letter: verseNum.letter } : {}) }, next)
}

function interpretLines(r: ReadRecording, nums: NameNumber[]): Interpreted {
  const reading = r.reading
  const take = reading.numbers.find((n) => n.marker === "take")?.value
  const markedPart = reading.numbers.find((n) => n.marker === "part")
  const base = { ...(take != null ? { take } : {}) }
  const lineMark = nums.find((n) => n.marker === "line" || n.marker === "verse")
  const plain = nums.filter((n) => !n.marker || n.marker === "chapter")
  // "part_003" alone: with nothing else to number, "part" counts the lines.
  if (!lineMark && plain.length === 0 && markedPart && !reading.numbers.some((n) => n !== markedPart && n.marker !== "take")) {
    return { wanted: { kind: "line", line: markedPart.value }, ...base }
  }
  const first = lineMark ?? plain[0]
  if (!first) return { wanted: { kind: "none" }, ...base }
  const others = lineMark ? [] : plain.slice(1)
  const part: PartInfo | undefined = markedPart
    ? partOf(reading, markedPart)
    : first.letter
      ? letterPart(first.letter)
      : reading.partWord
        ? partOf(reading)
        : undefined
  const next = others[0]
  if (next && isRangeSep(next.sepBefore)) {
    return { wanted: { kind: "lineRange", line: first.value, toLine: next.value }, ...base }
  }
  if (others.length > 1) return { wanted: { kind: "error", reason: { code: "tooManyNumbers" } }, ...base }
  if (next) return { wanted: { kind: "line", line: first.value }, ...base, part: partOf(reading, next) }
  return { wanted: { kind: "line", line: first.value }, ...base, ...(part ? { part } : {}) }
}

// ── Looking lines up ─────────────────────────────────────────────────────────

const VERSE_REF = /^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+)([a-z])?(?:-(\d+)([a-z])?)?$/

interface FileIndex {
  file: TargetFile
  bible: boolean
  /** Lines that take recordings by number or order: not headings, in order. */
  content: TargetLine[]
  /** "1:4" and "1:4a" → the line holding that verse. */
  verses: Map<string, TargetLine>
  chapters: Map<number, TargetLine[]>
  /** Each chapter's last verse number, in chapter order: how a verse's place
   *  in the book ("LN619") becomes its chapter and verse. The numbering, not
   *  the lines, so a bridged line or a verse the project leaves out (17:21)
   *  moves nothing after it. */
  chapterLengths: [chapter: number, verses: number][]
  /** Position of each line in `content`. */
  position: Map<string, number>
}

function indexFile(file: TargetFile): FileIndex {
  const content = file.lines.filter((l) => !l.structural)
  const verses = new Map<string, TargetLine>()
  const chapters = new Map<number, TargetLine[]>()
  let verseLines = 0
  for (const line of content) {
    const m = line.ref ? VERSE_REF.exec(line.ref) : null
    if (!m) continue
    verseLines++
    const chapter = Number(m[2])
    const from = Number(m[3])
    const to = m[5] ? Number(m[5]) : from
    for (let v = from; v <= to; v++) {
      if (!verses.has(`${chapter}:${v}`)) verses.set(`${chapter}:${v}`, line)
    }
    if (m[4]) verses.set(`${chapter}:${from}${m[4]}`, line)
    const list = chapters.get(chapter) ?? []
    list.push(line)
    chapters.set(chapter, list)
  }
  const lastVerse = new Map<number, number>()
  for (const key of verses.keys()) {
    const m = /^(\d+):(\d+)$/.exec(key)
    if (m) lastVerse.set(Number(m[1]), Math.max(lastVerse.get(Number(m[1])) ?? 0, Number(m[2])))
  }
  return {
    file,
    bible: file.bookCode != null || (content.length > 0 && verseLines * 2 >= content.length),
    content,
    verses,
    chapters,
    chapterLengths: [...lastVerse].sort((a, b) => a[0] - b[0]),
    position: new Map(content.map((l, i) => [l.cellId, i])),
  }
}

function bookLabel(fi: FileIndex): string {
  return fi.file.bookCode ? englishBookName(fi.file.bookCode) : fi.file.name
}

function refLabel(fi: FileIndex, chapter: number, verse: number | string): string {
  return `${bookLabel(fi)} ${chapter}:${verse}`
}

type Resolved = { cellIds: string[]; read: string } | { reason: UnmatchedReason }

/**
 * A verse's file landing on a bridged line ("MAT 19:1-2") is that line's piece
 * for the verse, so verses 1 and 2 join in order rather than becoming two
 * takes of the whole line. Files that all name the same verse of it are takes
 * of the line instead (`takesOnOneVerse`).
 */
function bridgedPart(line: TargetLine, verse: number): PartInfo | undefined {
  const m = line.ref ? VERSE_REF.exec(line.ref) : null
  return m && m[5] && Number(m[5]) > Number(m[3]) ? { rank: verse, label: String(verse), bridged: true } : undefined
}

function resolve(fi: FileIndex, wanted: Wanted, part: PartInfo | undefined): Resolved & { part?: PartInfo } {
  switch (wanted.kind) {
    case "verse": {
      if (!fi.chapters.has(wanted.chapter)) {
        return { reason: { code: "noSuchChapter", book: bookLabel(fi), chapter: wanted.chapter } }
      }
      // "1-4a" is the project's own verse 4a when it has one; otherwise "a" is a part.
      if (wanted.letter) {
        const own = fi.verses.get(`${wanted.chapter}:${wanted.verse}${wanted.letter}`)
        if (own) return { cellIds: [own.cellId], read: refLabel(fi, wanted.chapter, `${wanted.verse}${wanted.letter}`) }
      }
      const line = fi.verses.get(`${wanted.chapter}:${wanted.verse}`)
      if (!line) return { reason: { code: "noSuchVerse", ref: refLabel(fi, wanted.chapter, wanted.verse) } }
      const letterAsPart = wanted.letter && !part ? letterPart(wanted.letter) : part ?? bridgedPart(line, wanted.verse)
      return { cellIds: [line.cellId], read: refLabel(fi, wanted.chapter, wanted.verse), ...(letterAsPart ? { part: letterAsPart } : {}) }
    }
    case "bookVerse": {
      let left = wanted.count
      let at: { chapter: number; verse: number } | null = null
      for (const [chapter, count] of fi.chapterLengths) {
        if (left <= count) { at = { chapter, verse: left }; break }
        left -= count
      }
      if (!at || wanted.count < 1) {
        const verses = fi.chapterLengths.reduce((sum, [, count]) => sum + count, 0)
        return { reason: { code: "noSuchBookVerse", count: wanted.count, verses, book: bookLabel(fi) } }
      }
      if (wanted.verse != null && wanted.verse !== at.verse) {
        return { reason: { code: "bookVerseDisagree", count: wanted.count, verse: wanted.verse, ref: refLabel(fi, at.chapter, at.verse) } }
      }
      return resolve(fi, { kind: "verse", chapter: at.chapter, verse: at.verse }, part)
    }
    case "verseRange": {
      const from = fi.verses.get(`${wanted.chapter}:${wanted.verse}`)
      const to = fi.verses.get(`${wanted.toChapter}:${wanted.toVerse}`)
      if (!from) return { reason: fi.chapters.has(wanted.chapter) ? { code: "noSuchVerse", ref: refLabel(fi, wanted.chapter, wanted.verse) } : { code: "noSuchChapter", book: bookLabel(fi), chapter: wanted.chapter } }
      if (!to) return { reason: fi.chapters.has(wanted.toChapter) ? { code: "noSuchVerse", ref: refLabel(fi, wanted.toChapter, wanted.toVerse) } : { code: "noSuchChapter", book: bookLabel(fi), chapter: wanted.toChapter } }
      const lo = fi.position.get(from.cellId)!
      const hi = fi.position.get(to.cellId)!
      // "1-5-3" runs backwards: a typo, or two numbers swapped. Say so rather
      // than quietly covering 1:3 to 1:5.
      if (hi < lo) {
        return { reason: { code: "rangeBackwards", from: refLabel(fi, wanted.chapter, wanted.verse), to: refLabel(fi, wanted.toChapter, wanted.toVerse) } }
      }
      const cellIds = fi.content.slice(lo, hi + 1).filter((l) => l.ref && VERSE_REF.test(l.ref)).map((l) => l.cellId)
      const read = wanted.chapter === wanted.toChapter
        ? `${refLabel(fi, wanted.chapter, wanted.verse)}–${wanted.toVerse}`
        : `${refLabel(fi, wanted.chapter, wanted.verse)}–${wanted.toChapter}:${wanted.toVerse}`
      return { cellIds, read }
    }
    case "chapter": {
      const lines = fi.chapters.get(wanted.chapter)
      if (!lines || lines.length === 0) return { reason: { code: "noSuchChapter", book: bookLabel(fi), chapter: wanted.chapter } }
      return { cellIds: lines.map((l) => l.cellId), read: `${bookLabel(fi)} ${wanted.chapter}` }
    }
    case "line": {
      const line = fi.content[wanted.line - 1]
      if (!line || wanted.line < 1) return { reason: { code: "noSuchLine", line: wanted.line, count: fi.content.length } }
      // A verse counted from the top reads as its verse ("Genesis 2:5").
      return { cellIds: [line.cellId], read: lineReadLabel(fi, line, wanted.line - 1), ...(part ? { part } : {}) }
    }
    case "lineRange": {
      if (wanted.toLine < wanted.line) return { reason: { code: "rangeBackwards", from: `line ${wanted.line}`, to: `line ${wanted.toLine}` } }
      const [lo, hi] = [wanted.line, wanted.toLine]
      if (lo < 1 || !fi.content[lo - 1]) return { reason: { code: "noSuchLine", line: lo, count: fi.content.length } }
      if (!fi.content[hi - 1]) return { reason: { code: "noSuchLine", line: hi, count: fi.content.length } }
      return { cellIds: fi.content.slice(lo - 1, hi).map((l) => l.cellId), read: `lines ${lo}–${hi}` }
    }
    case "none":
      return { reason: { code: "noNumber" } }
    case "error":
      return { reason: wanted.reason }
  }
}

/**
 * Sam, Oct 29: on a file whose lines have times (a subtitle or film file), a
 * name covering several lines is not uploaded. Its one recording would start
 * at the first line's time and sound over every line after it, so on the
 * timeline it overlaps itself. A range that is one line of the file (a bridged
 * verse, "1:1-2") is still one recording for one line, and goes up.
 */
function refuseRangeOnTimed<R extends Resolved>(fi: FileIndex, res: R): R | { reason: UnmatchedReason } {
  return fi.file.timed && "cellIds" in res && res.cellIds.length > 1 ? { reason: { code: "rangeOnTimedFile" } } : res
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** Reasons no choice of line can fix: the file is not a recording at all. */
const REFUSED: ReadonlySet<UnmatchedReason["code"]> = new Set(["notAudio", "unplayableFormat", "systemFile", "empty", "tooLarge"])

/** True when the person may still pick a line for this file in the preview. */
export function canChooseLine(a: Assignment): boolean {
  return !a.reason || !REFUSED.has(a.reason.code)
}

/** Reads a name with no book table, for a destination that is not a Bible book. */
const NO_BOOKS = new BookNameIndex({ builtins: false })

export interface MatchOptions {
  /** Moves an order run's start: +1 starts it one line later, −1 one earlier. */
  orderShift?: ReadonlyMap<string, number>
  /** Starts an order run at this line (its cell id); `orderShift` then moves it from there. */
  orderStart?: ReadonlyMap<string, string>
  /** Lines the person chose by hand, or "skip" to leave a file out. */
  overrides?: ReadonlyMap<number, { fileId: string; cellId: string } | "skip">
  /** Each recording's length in ms, by input index: read for the files the
   *  count couldn't place (`needsLength`), which then go by their length. */
  lengths?: ReadonlyMap<number, number>
}

/** The target, as one identity string, for duplicate detection. */
function targetLabel(a: Assignment): string {
  return a.read ?? ""
}

/**
 * Every recording's line. `read` comes from `readRecordings`; `targets` holds
 * the lines of every file it named.
 */
export function matchRecordings(
  read: readonly ReadRecording[],
  targets: ReadonlyMap<string, TargetFile>,
  opts: MatchOptions = {},
): Assignment[] {
  const indexes = new Map<string, FileIndex>()
  const fileIndex = (fileId: string) => {
    let fi = indexes.get(fileId)
    if (!fi) {
      const file = targets.get(fileId)
      if (!file) return undefined
      fi = indexFile(file)
      indexes.set(fileId, fi)
    }
    return fi
  }
  const out = new Map<number, Assignment>()
  for (const r of read) {
    if (r.refused) out.set(r.index, { index: r.index, reason: r.refused })
    else if (!r.targetFileId) out.set(r.index, { index: r.index, reason: r.targetReason ?? { code: "noBook" } })
  }

  // One naming scheme per folder and destination file.
  const groups = new Map<string, ReadRecording[]>()
  for (const r of read) {
    if (r.refused || !r.targetFileId) continue
    const key = `${r.targetFileId}\u0000${r.folderKey}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  for (const [groupKey, rawGroup] of groups) {
    const fi = fileIndex(rawGroup[0].targetFileId!)
    if (!fi) {
      for (const r of rawGroup) out.set(r.index, { index: r.index, reason: { code: "noBook" } })
      continue
    }
    const singleChapter = fi.chapters.size === 1 && fi.chapters.has(1)
    // Outside a Bible book a name holds no book: "This is 12" is line 12, not
    // Isaiah. Inside one, a folder's number that is not one of the book's
    // chapters ("2023") is not a chapter folder.
    const group = fi.bible
      ? rawGroup.map((r) => (r.folderChapter && !fi.chapters.has(r.folderChapter.chapter) ? { ...r, folderChapter: undefined } : r))
      : rawGroup.map((r) => (r.reading.book ? { ...r, reading: readName(r.file.name, NO_BOOKS) } : r))
    const nums = pruneConstants(group, fi.bible, fi.file.bookCode)
    // A number alone in a Bible book: chapter or verse, by the folder's count.
    const lone = new Map<number, NameNumber>()
    if (fi.bible) {
      for (const r of group) {
        const n = loneNumber(r, nums.get(r.index)!)
        if (n) lone.set(r.index, n)
      }
    }
    const loneReading = lone.size > 0 ? readLoneNumbers(fi, lone, singleChapter, opts.lengths) : undefined
    const byLength = loneReading && loneReading.as !== "unknown" && loneReading.byLengthMs != null
      ? { as: loneReading.as, ms: loneReading.byLengthMs }
      : undefined
    const results = group.map((r) => {
      // In one Bible book, a name of another book is the wrong file.
      if (fi.bible && fi.file.bookCode && r.reading.book && r.reading.book.code !== fi.file.bookCode) {
        return { r, res: { reason: { code: "otherBook", book: englishBookName(r.reading.book.code), fileName: bookLabel(fi) } as UnmatchedReason } as Resolved, interp: null as Interpreted | null }
      }
      const interp = fi.bible ? interpretBible(r, nums.get(r.index)!, singleChapter, lone.has(r.index) ? loneReading : undefined) : interpretLines(r, nums.get(r.index)!)
      return { r, res: refuseRangeOnTimed(fi, resolve(fi, interp.wanted, interp.part)), interp }
    })

    // No file in the folder has a number that finds a line: the folder has no
    // naming scheme ("IMG_4521", "New Recording"), so folder order decides.
    const anyFound = results.some((x) => "cellIds" in x.res)
    const anyNumbered = results.some((x) => x.interp && x.interp.wanted.kind !== "none")
    const otherBookOnly = results.every((x) => !x.interp)
    // "IMG_4521" is a counter, not a line: a name with one number that finds
    // nothing reads the same whether that number became a line or a verse.
    // A lone number in a Bible book is a counter when it is neither one of the
    // book's chapters nor one of its verses, however the count read it.
    const loneFinds = (index: number) => {
      const n = lone.get(index)
      if (!n) return false
      return "cellIds" in resolve(fi, { kind: "chapter", chapter: n.value }, undefined) || "cellIds" in resolve(fi, { kind: "line", line: n.value }, undefined)
    }
    const counterLike = (x: (typeof results)[number]) =>
      !x.interp || x.interp.wanted.kind === "none" ||
      ((x.interp.wanted.kind === "line" || x.interp.wanted.kind === "verse") && (nums.get(x.r.index)?.length ?? 0) <= 1) ||
      (lone.has(x.r.index) && !loneFinds(x.r.index))
    if (!anyFound && !otherBookOnly && (anyNumbered ? results.every(counterLike) : true)) {
      for (const x of results) if (!x.interp && "reason" in x.res) out.set(x.r.index, { index: x.r.index, reason: x.res.reason })
      // A file the person left out or placed by hand leaves the run, and the
      // run closes up behind it: skipping a junk clip moves the later files
      // up one line instead of leaving its line empty.
      const handled = (index: number) => opts.overrides?.has(index) === true
      for (const x of results) if (x.interp && handled(x.r.index)) out.set(x.r.index, { index: x.r.index, method: "order", orderRun: groupKey })
      const ordered = results.filter((x) => x.interp && !handled(x.r.index)).map((x) => x.r).sort((a, b) => compareFolderOrder(a.file.path, b.file.path))
      // A folder named for a chapter ("Ruth 2") starts the run at its first
      // verse; otherwise at the file's first line. The person moves it from there.
      const folderChapter = ordered[0]?.folderChapter?.chapter
      const chapterStart = fi.bible && folderChapter != null ? fi.chapters.get(folderChapter)?.[0] : undefined
      const base = chapterStart ? fi.position.get(chapterStart.cellId) ?? 0 : 0
      const start = opts.orderStart?.get(groupKey)
      const startAt = start ? fi.position.get(start) : undefined
      const shift = (startAt ?? base) + (opts.orderShift?.get(groupKey) ?? 0)
      ordered.forEach((r, pos) => {
        const at = pos + shift
        const line = at >= 0 ? fi.content[at] : undefined
        out.set(r.index, line
          ? { index: r.index, method: "order", fileId: fi.file.fileId, cellIds: [line.cellId], orderRun: groupKey, read: lineReadLabel(fi, line, at), ...(chapterStart && startAt == null ? { fromFolder: ordered[0].folderChapter!.segment } : {}) }
          : { index: r.index, method: "order", orderRun: groupKey, reason: at < 0 ? { code: "beforeFirstLine" } : { code: "pastLastLine", count: fi.content.length } })
      })
      continue
    }

    for (const { r, res, interp } of results) {
      if ("reason" in res) {
        out.set(r.index, { index: r.index, reason: res.reason })
        continue
      }
      const byName = Boolean(r.reading.book) || (!fi.bible && r.reading.words.length > 0 && fileNameKey(r.reading.stem).startsWith(fileNameKey(fi.file.name)))
      const part = (res as { part?: PartInfo }).part
      out.set(r.index, {
        index: r.index,
        method: byName ? "name" : "number",
        fileId: fi.file.fileId,
        cellIds: res.cellIds,
        read: res.read,
        ...(part ? { part } : {}),
        ...(interp?.take != null ? { take: interp.take } : {}),
        ...(byLength && lone.has(r.index) ? { byLength } : {}),
        ...(!r.reading.book && r.folderBook ? { fromFolder: r.folderBook.segment } : r.folderChapter && interp?.folderChapter ? { fromFolder: r.folderChapter.segment } : {}),
      })
    }
  }

  takesOnOneVerse(out)

  // The person's own choices win over every rule.
  for (const [index, choice] of opts.overrides ?? []) {
    const prev = out.get(index)
    if (!prev || (prev.reason && REFUSED.has(prev.reason.code))) continue
    if (choice === "skip") {
      out.set(index, { index, reason: { code: "skipped" } })
      continue
    }
    const fi = fileIndex(choice.fileId)
    const line = fi?.file.lines.find((l) => l.cellId === choice.cellId)
    if (!fi || !line) continue
    const at = fi.position.get(line.cellId)
    out.set(index, {
      index,
      method: prev.method ?? "name",
      fileId: choice.fileId,
      cellIds: [choice.cellId],
      read: lineReadLabel(fi, line, at ?? -1),
      chosen: true,
      ...(prev.part && prev.cellIds?.length === 1 && prev.cellIds[0] === choice.cellId ? { part: prev.part } : {}),
    })
  }

  return settleConflicts(read, [...out.values()].sort((a, b) => a.index - b.index))
}

/**
 * On a bridged line, files that all name the same one of its verses ("1-1",
 * "1-1 take 2" on "1:1-2") are takes of the line, not pieces of it: one verse
 * twice is a retake (rule 4). Different verses stay its pieces.
 */
function takesOnOneVerse(out: Map<number, Assignment>): void {
  const byLine = new Map<string, Assignment[]>()
  for (const a of out.values()) {
    if (!a.part?.bridged || a.cellIds?.length !== 1) continue
    const key = `${a.fileId}\u0000${a.cellIds[0]}`
    byLine.set(key, [...(byLine.get(key) ?? []), a])
  }
  for (const list of byLine.values()) {
    if (list.length < 2 || new Set(list.map((a) => a.part!.rank)).size !== 1) continue
    for (const a of list) {
      const { part: _part, ...rest } = a
      out.set(a.index, rest)
    }
  }
}

/** How a chosen or order-placed line reads in the preview. */
function lineReadLabel(fi: FileIndex, line: TargetLine, position: number): string {
  const m = line.ref ? VERSE_REF.exec(line.ref) : null
  if (m) return `${bookLabel(fi)} ${m[2]}:${m[3]}${m[4] ?? ""}${m[5] ? `-${m[5]}${m[6] ?? ""}` : ""}`
  return position >= 0 ? `line ${position + 1}` : fi.file.name
}

/**
 * Two files on one line. Pieces of one verse share it. So do any files that
 * are not parts (Sam, Oct 29): each uploads as a take of the line, whether the
 * names say "take 2", say the same verse twice ("Genesis 1-1", "Genesis 1-1
 * copy") or the person chose the line for one of them. What can't share a line
 * — a range over it, a part beside a whole recording, two of the same part — is
 * kept by the first in folder order, and the other is listed with the name of
 * the file that has it. A chosen line outranks a rule's.
 */
function settleConflicts(read: readonly ReadRecording[], assignments: Assignment[]): Assignment[] {
  const nameOf = (i: number) => read[i]?.file.name ?? ""
  const pathOf = (i: number) => read[i]?.file.path ?? ""
  // Every assignment on each line, so a third file is compared with all of them.
  const claims = new Map<string, Assignment[]>()
  const order = assignments
    .filter((a) => a.cellIds && a.cellIds.length > 0)
    .sort((a, b) => Number(Boolean(b.chosen)) - Number(Boolean(a.chosen)) || compareFolderOrder(pathOf(a.index), pathOf(b.index)))
  const dropped = new Map<number, UnmatchedReason>()
  for (const a of order) {
    let clash: Assignment | undefined
    for (const cellId of a.cellIds!) {
      const held = claims.get(`${a.fileId}\u0000${cellId}`) ?? []
      for (const h of held) {
        const sameLine = h.cellIds!.length === 1 && a.cellIds!.length === 1
        const pieces = sameLine && h.part != null && a.part != null && h.part.rank !== a.part.rank
        const takes = sameLine && !h.part && !a.part
        if (!pieces && !takes) { clash = h; break }
      }
      if (clash) break
    }
    if (clash) {
      dropped.set(a.index, { code: "duplicate", target: targetLabel(clash), other: nameOf(clash.index) })
      continue
    }
    for (const cellId of a.cellIds!) {
      const key = `${a.fileId}\u0000${cellId}`
      claims.set(key, [...(claims.get(key) ?? []), a])
    }
  }
  return assignments.map((a) => {
    const reason = dropped.get(a.index)
    return reason ? { index: a.index, reason, ...(a.orderRun ? { orderRun: a.orderRun } : {}) } : a
  })
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** What the upload engine runs. Lines of one job are written in order. */
export type UploadJob =
  | { kind: "single"; fileId: string; cellId: string; files: number[] }
  | { kind: "range"; fileId: string; cellIds: string[]; files: [number] }
  | { kind: "pieces"; fileId: string; cellId: string; files: number[] }

/**
 * True when every file for one line is a numbered take with its own number:
 * they upload in that order, so the highest plays. Otherwise the most recently
 * modified file plays (Sam, Oct 29).
 */
export function takesByNumber(list: readonly Assignment[]): boolean {
  const numbers = list.map((a) => a.take)
  return numbers.every((n) => n != null) && new Set(numbers).size === numbers.length
}

/**
 * Group the matched files into upload jobs:
 *   - one file on one line → a single take;
 *   - several files for one line → one job of takes, uploaded one after
 *     another so the last plays: by take number when each has one, otherwise
 *     oldest first by File.lastModified, a tie going by folder order (Sam,
 *     Oct 29: the more recently modified plays; on a tie, the later in folder
 *     order);
 *   - one file over several lines → one shared recording on each of them;
 *   - the parts of one verse → one job, joined into pieces of one take.
 * A verse named as a part with no other part is simply its recording.
 */
export function planJobs(assignments: readonly Assignment[], read: readonly ReadRecording[]): UploadJob[] {
  const pathOf = (i: number) => read[i]?.file.path ?? ""
  const byLine = new Map<string, Assignment[]>()
  const jobs: UploadJob[] = []
  for (const a of assignments) {
    if (!a.cellIds || !a.fileId) continue
    if (a.cellIds.length > 1) {
      jobs.push({ kind: "range", fileId: a.fileId, cellIds: a.cellIds, files: [a.index] })
      continue
    }
    const key = `${a.fileId}\u0000${a.cellIds[0]}`
    const list = byLine.get(key) ?? []
    list.push(a)
    byLine.set(key, list)
  }
  for (const list of byLine.values()) {
    const { fileId } = list[0]
    const cellId = list[0].cellIds![0]
    const parts = list.filter((a) => a.part)
    if (parts.length > 1) {
      const ordered = [...parts].sort((a, b) => a.part!.rank - b.part!.rank || compareFolderOrder(pathOf(a.index), pathOf(b.index)))
      jobs.push({ kind: "pieces", fileId: fileId!, cellId, files: ordered.map((a) => a.index) })
      continue
    }
    const modified = (i: number) => read[i]?.file.lastModified ?? 0
    const ordered = takesByNumber(list)
      ? [...list].sort((a, b) => a.take! - b.take! || compareFolderOrder(pathOf(a.index), pathOf(b.index)))
      : [...list].sort((a, b) => modified(a.index) - modified(b.index) || compareFolderOrder(pathOf(a.index), pathOf(b.index)))
    jobs.push({ kind: "single", fileId: fileId!, cellId, files: ordered.map((a) => a.index) })
  }
  return jobs
}

/** For a part with no sibling: the preview says it is the verse's only file. */
export function lonePart(assignment: Assignment, assignments: readonly Assignment[]): boolean {
  if (!assignment.part || !assignment.cellIds || assignment.cellIds.length !== 1) return false
  const cellId = assignment.cellIds[0]
  return !assignments.some((a) => a !== assignment && a.part && a.fileId === assignment.fileId && a.cellIds?.length === 1 && a.cellIds[0] === cellId)
}

