/**
 * Biblica study-Bible IDML style rules.
 *
 * Biblica InDesign templates encode their semantics in style names rather than
 * in structure: `intro:*` paragraphs are the study notes, `cv:v*` character runs
 * are verse numbers, `meta:bk` paragraphs carry the book code, and so on.
 * InDesign URL-encodes the colon in applied style names, so every check accepts
 * both `meta%3abk` and `meta:bk`.
 */

/** InDesign ACE placeholder markers in running headers / structural paragraphs. */
const ACE_MARKER_PATTERN = /<\?ACE\s+\d+\?>/gi

/** Apostrophe characters used as structural glue in English Biblica IDML (source serif). */
const STRUCTURAL_APOSTROPHE_PATTERN = /^['\u02BC\u2019\u2032\u00B4]+$/

function hasStyleToken(styleName: string, prefix: string, suffix = ""): boolean {
  return styleName.includes(`${prefix}%3a${suffix}`) || styleName.includes(`${prefix}:${suffix}`)
}

/** Note styles use the intro prefix (e.g. intro%3aipi, intro%3aili1). */
export function isBiblicaNoteSectionStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "intro")
}

/** The paragraph whose text is the 2–4 character book abbreviation. */
export function isBiblicaBookMarkerStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "meta", "bk")
}

/** Chapter-label headings such as "Psalm 2", which open a new chapter grouping. */
export function isBiblicaChapterHeadingStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "head", "cl")
}

/**
 * Running heads (`meta:rh`): the folio line InDesign regenerates from the layout
 * on every reflow. It holds no translatable text and owns no cell.
 */
export function isBiblicaRunningHeadStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "meta", "rh")
}

/**
 * Headings that open a section in a front/back-matter volume: the volume's own
 * `intro:imt2` headings and major section heads (`head:ms1` — the Bible
 * Dictionary sets one per alphabet letter).
 */
export function isBiblicaFrontMatterHeadingStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "intro", "imt2")
    || hasStyleToken(paragraphStyle, "head", "ms1")
}

/** Verse-number runs (`cv:v`, `cv:v1`). */
export function isVerseNumberCharacterStyle(characterStyle: string): boolean {
  return hasStyleToken(characterStyle, "cv", "v")
}

/** Drop-cap chapter numbers (`cv:dc`), used by books like Job. */
export function isChapterNumberCharacterStyle(characterStyle: string): boolean {
  return hasStyleToken(characterStyle, "cv", "dc")
}

/** Chapter meta markers (`meta:c`), used by Psalms ("1:", "2:"). */
export function isMetaChapterCharacterStyle(characterStyle: string): boolean {
  return hasStyleToken(characterStyle, "meta", "c")
}

/** Verse bookend markers (`meta:v`) that open and close a verse body. */
export function isMetaVerseCharacterStyle(characterStyle: string): boolean {
  return hasStyleToken(characterStyle, "meta", "v")
}

/**
 * Any chapter/verse delimiter run. Their total absence is what identifies a
 * front/back-matter volume: Biblica ships title pages, tables of contents, the
 * Bible Dictionary and the like as separate IDML packages with no scripture in
 * them at all, so no chapter or verse is ever marked.
 */
export function isChapterVerseMarkerCharacterStyle(characterStyle: string): boolean {
  return isVerseNumberCharacterStyle(characterStyle)
    || isChapterNumberCharacterStyle(characterStyle)
    || isMetaChapterCharacterStyle(characterStyle)
    || isMetaVerseCharacterStyle(characterStyle)
}

/** True for InDesign "source serif" apostrophe glue. */
export function isSourceSerifCharacterStyle(characterStyle: string): boolean {
  return characterStyle.toLowerCase().includes("source serif")
}

export function isStructuralApostropheContent(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && STRUCTURAL_APOSTROPHE_PATTERN.test(trimmed)
}

export function isStructuralApostropheSegment(text: string, characterStyle?: string): boolean {
  if (characterStyle && isSourceSerifCharacterStyle(characterStyle)) {
    return true
  }
  return isStructuralApostropheContent(text)
}

/** True when visible text is empty after stripping ACE markers and whitespace. */
export function isStructuralOnlyContent(segments: readonly string[]): boolean {
  const visible = segments
    .join("")
    .replace(ACE_MARKER_PATTERN, "")
    .replace(/\s+/g, "")
    .trim()
  return visible.length === 0
}

/** USFM book codes accepted by the fallback book detection below. */
export const BIBLICA_BOOK_CODES: ReadonlySet<string> = new Set([
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT",
  "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH",
  "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER",
  "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON",
  "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL", "MAT",
  "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL",
  "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT",
  "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN",
  "JUD", "REV",
])

/**
 * Fallback book detection for files whose first pages name the book inline
 * ("GEN — Genesis") instead of carrying a `meta:bk` paragraph.
 */
export function bookCodeFromParagraphText(text: string): string | undefined {
  const match = text.trim().match(/^([A-Z0-9]{3})\s*[-–—\n]/)
  return match && BIBLICA_BOOK_CODES.has(match[1]) ? match[1] : undefined
}

/**
 * Compute the chapter-range label for a note section.
 * - "Preface" if no verses have been scanned in this book yet.
 * - "3" if only chapter 3 was scanned since the last note section.
 * - "1-2" if chapters 1 through 2 were scanned since the last note section.
 */
export function computeChapterRangeLabel(
  firstChapter: string | null,
  lastChapter: string | null,
  hasEncounteredVerses: boolean,
): string {
  if (!hasEncounteredVerses || !firstChapter) return "Preface"
  if (!lastChapter || firstChapter === lastChapter) return firstChapter
  return `${firstChapter}-${lastChapter}`
}
