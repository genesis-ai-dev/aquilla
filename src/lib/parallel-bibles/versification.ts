// Lining up versions whose verse numbers differ — a small table, not a
// versification engine.
//
// The editor's refs are English-numbered (the numbering of the project's
// source). Hebrew Bibles (the Masoretic numbering WLC and friends follow)
// differ in a known set of places: a few chapter boundaries fall elsewhere
// (English Malachi 4 is Hebrew Malachi 3:19-24), and most psalm titles are
// counted as verse 1 (or 1-2). Where the table knows the answer the panel
// shows the right verse and says the numbers differ; anything else that does
// not line up — a missing verse, a chapter with a different verse count — is
// flagged by the caller rather than shown as if it matched.
//
// Pure.

export type VersificationScheme = "english" | "hebrew"

const HEBREW_NUMBERED_LANGUAGES = new Set(["hbo", "he", "heb", "arc"])

/** helloao gives ISO 639-3. Hebrew-language Bibles follow the Hebrew numbering. */
export function versificationScheme(language: string | null | undefined): VersificationScheme {
  return HEBREW_NUMBERED_LANGUAGES.has((language ?? "").trim().toLowerCase()) ? "hebrew" : "english"
}

interface ShiftRule {
  book: string
  /** English chapter and inclusive verse range the rule covers. */
  chapter: number
  from: number
  to: number
  /** Where those verses are in the Hebrew numbering. */
  hebrewChapter: number
  /** Hebrew verse = English verse + shift. */
  shift: number
}

/**
 * English → Hebrew chapter-boundary differences. Each row is a contiguous run;
 * a verse no row covers has the same number in both.
 */
export const ENGLISH_TO_HEBREW_SHIFTS: readonly ShiftRule[] = [
  { book: "GEN", chapter: 31, from: 55, to: 55, hebrewChapter: 32, shift: -54 },
  { book: "GEN", chapter: 32, from: 1, to: 32, hebrewChapter: 32, shift: 1 },
  { book: "EXO", chapter: 8, from: 1, to: 4, hebrewChapter: 7, shift: 25 },
  { book: "EXO", chapter: 8, from: 5, to: 32, hebrewChapter: 8, shift: -4 },
  { book: "ISA", chapter: 9, from: 1, to: 1, hebrewChapter: 8, shift: 22 },
  { book: "ISA", chapter: 9, from: 2, to: 21, hebrewChapter: 9, shift: -1 },
  { book: "DAN", chapter: 4, from: 1, to: 3, hebrewChapter: 3, shift: 30 },
  { book: "DAN", chapter: 4, from: 4, to: 37, hebrewChapter: 4, shift: -3 },
  { book: "DAN", chapter: 5, from: 31, to: 31, hebrewChapter: 6, shift: -30 },
  { book: "DAN", chapter: 6, from: 1, to: 28, hebrewChapter: 6, shift: 1 },
  { book: "JOL", chapter: 2, from: 28, to: 32, hebrewChapter: 3, shift: -27 },
  { book: "JOL", chapter: 3, from: 1, to: 21, hebrewChapter: 4, shift: 0 },
  { book: "JON", chapter: 1, from: 17, to: 17, hebrewChapter: 2, shift: -16 },
  { book: "JON", chapter: 2, from: 1, to: 10, hebrewChapter: 2, shift: 1 },
  { book: "MIC", chapter: 5, from: 1, to: 1, hebrewChapter: 4, shift: 13 },
  { book: "MIC", chapter: 5, from: 2, to: 15, hebrewChapter: 5, shift: -1 },
  { book: "ZEC", chapter: 1, from: 18, to: 21, hebrewChapter: 2, shift: -17 },
  { book: "ZEC", chapter: 2, from: 1, to: 13, hebrewChapter: 2, shift: 4 },
  { book: "MAL", chapter: 4, from: 1, to: 6, hebrewChapter: 3, shift: 18 },
]

export interface MappedRef {
  chapter: number
  /** Null for a chapter-scoped ref. */
  verse: number | null
  /** True when the version numbers this verse differently from the editor. */
  shifted: boolean
}

/**
 * Where an English-numbered ref sits in a version. A chapter-scoped ref (no
 * verse) follows the chapter's verse 1, so English Malachi 4 opens Hebrew
 * Malachi 3. Psalm titles are not handled here — see psalmTitleOffset.
 */
export function mapEnglishRef(
  scheme: VersificationScheme,
  book: string,
  chapter: number,
  verse: number | null,
): MappedRef {
  if (scheme === "english") return { chapter, verse, shifted: false }
  const probe = verse ?? 1
  const rule = ENGLISH_TO_HEBREW_SHIFTS.find(
    (r) => r.book === book && r.chapter === chapter && probe >= r.from && probe <= r.to,
  )
  if (!rule || (rule.hebrewChapter === chapter && rule.shift === 0)) return { chapter, verse, shifted: false }
  return {
    chapter: rule.hebrewChapter,
    verse: verse === null ? null : verse + rule.shift,
    shifted: true,
  }
}

/** What a loaded chapter tells us about its numbering. */
export interface ChapterShape {
  verseCount: number
  /** An English chapter that carries the psalm title as an unnumbered line. */
  hasPsalmTitle: boolean
}

/**
 * How far a Hebrew psalm's verse numbers run ahead of the English ones because
 * the title is counted as verse 1 (or 1-2). Read off the two loaded chapters:
 * the English one carries the title unnumbered, and the Hebrew one has one or
 * two more verses. "unknown" when there is no English chapter to read, or the
 * counts do not settle it (Psalm 13 has a title and the same count) — the
 * caller then marks the column instead of guessing.
 */
export function psalmTitleOffset(
  english: ChapterShape | undefined,
  hebrewVerseCount: number,
): number | "unknown" {
  if (!english) return "unknown"
  if (!english.hasPsalmTitle) return 0
  const diff = hebrewVerseCount - english.verseCount
  return diff === 1 || diff === 2 ? diff : "unknown"
}

/** What a column says about its numbering, when it is not plain. */
export type VersificationNote =
  | { kind: "shifted"; here: string; english: string }
  | { kind: "psalmTitle"; offset: number }
  | { kind: "psalmUnsure" }
  | { kind: "countDiffers"; count: number; refCount: number; refVersion: string }

export interface VersionAlignment {
  /** The chapter to load for this version. */
  chapter: number
  /** The verse to show and highlight, or null for a chapter-scoped ref. */
  verse: number | null
  note: VersificationNote | null
}

/**
 * The verse a version should show for the editor's ref, and what to say about
 * it. `reference` is the first English-numbered column's loaded chapter (for
 * the psalm check and the verse-count check); `loaded` is this version's own
 * chapter once it has arrived.
 */
export function alignVersion(args: {
  scheme: VersificationScheme
  book: string
  chapter: number
  verse: number | null
  loaded?: ChapterShape
  reference?: ChapterShape & { versionLabel: string; isSelf: boolean }
}): VersionAlignment {
  const { scheme, book, chapter, verse, loaded, reference } = args
  const mapped = mapEnglishRef(scheme, book, chapter, verse)
  if (mapped.shifted) {
    const here = `${book} ${mapped.chapter}${mapped.verse !== null ? `:${mapped.verse}` : ""}`
    const english = `${book} ${chapter}${verse !== null ? `:${verse}` : ""}`
    return { chapter: mapped.chapter, verse: mapped.verse, note: { kind: "shifted", here, english } }
  }
  if (scheme === "hebrew" && book === "PSA") {
    if (!loaded) return { chapter, verse, note: null }
    const offset = psalmTitleOffset(reference && !reference.isSelf ? reference : undefined, loaded.verseCount)
    if (offset === "unknown") return { chapter, verse, note: { kind: "psalmUnsure" } }
    if (offset > 0) {
      return { chapter, verse: verse === null ? null : verse + offset, note: { kind: "psalmTitle", offset } }
    }
  }
  if (loaded && reference && !reference.isSelf && loaded.verseCount !== reference.verseCount) {
    return {
      chapter,
      verse,
      note: {
        kind: "countDiffers",
        count: loaded.verseCount,
        refCount: reference.verseCount,
        refVersion: reference.versionLabel,
      },
    }
  }
  return { chapter, verse, note: null }
}
