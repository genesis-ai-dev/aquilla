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

/** Character styles that carry a chapter/verse delimiter (USFM `\c` and `\v`). */
const VERSE_MARKER_STYLE_PATTERN = /(?:^|\/)meta(?:%3a|:)[cv](?:_sp)?$/i

function hasStyleToken(styleName: string, prefix: string, suffix = ""): boolean {
  return styleName.includes(`${prefix}%3a${suffix}`) || styleName.includes(`${prefix}:${suffix}`)
}

/**
 * The style groups the study-Bible template is built from. A volume may add
 * groups of its own for a feature — the back matter sets its timeline under
 * `Drama of the Bible:*` — but every study-Bible volume uses some of these.
 */
const STUDY_TEMPLATE_GROUPS: ReadonlySet<string> = new Set([
  "intro", "meta", "head", "text", "toc", "title", "cv", "fig", "tbl", "list", "note", "ref",
])

/** The applied style as InDesign wrote it, with its path and encoding undone. */
function decodeStyleName(styleName: string): string {
  const name = styleName.startsWith("ParagraphStyle/")
    ? styleName.slice("ParagraphStyle/".length)
    : styleName
  if (!name.includes("%")) return name
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * True for a paragraph set in the study Bible's own vocabulary (`intro:ip`,
 * `text:m`, `cv:v1`, `title:mt1`).
 *
 * Biblica's other titles are built from templates that share none of it: the
 * Treasure Hunt Bible names its styles `par`, `toc_l2`, `!meta_par`, `pNormal`,
 * and Reach 4 Life groups its own under proper names (`R4Lv4 Paragraph
 * Styles:Lesson body`, `Poetry:q1`). Recognizing that is what lets the importer
 * say "tick the matching box" instead of importing the wrong thing.
 */
export function isBiblicaStudyTemplateStyle(paragraphStyle: string): boolean {
  const name = decodeStyleName(paragraphStyle)
  const group = name.split(":")[0]?.trim().toLowerCase() ?? ""
  return name.includes(":") && STUDY_TEMPLATE_GROUPS.has(group)
}

/**
 * True for InDesign's own unnamed defaults (`$ID/NormalParagraphStyle`). A
 * package that uses nothing else — the study Bible's cover, which is artwork
 * with a few lines of type over it — belongs to no template at all.
 */
export function isUnnamedParagraphStyle(paragraphStyle: string): boolean {
  return decodeStyleName(paragraphStyle).startsWith("$ID/")
}

/** Note styles use the intro prefix (e.g. intro%3aipi, intro%3aili1). */
export function isBiblicaNoteSectionStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "intro")
}

/**
 * Headings printed inside the scripture flow (`head:*`).
 *
 * Unlike the verses around them, these are not swapped in from a Bible
 * translation — they are set in the study Bible's own layout and have to be
 * translated here. The Psalter is where they carry the most text: chapter
 * labels ("Psalm 1", `head:cl`), superscriptions ("A psalm of David",
 * `head:d_h`), speaker lines (`head:sp`), the acrostic letters of Psalm 119
 * (`head:qa`) and the five-book headings ("Book I", `head:ms`, with its range
 * "Psalms 1—41", `head:mr_h`).
 *
 * Auto-generated running heads live in `meta:rh`, not here, so nothing the
 * layout repeats is picked up.
 */
export function isBiblicaScriptureHeadingStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "head")
}

/** The paragraph whose text is the 2–4 character book abbreviation. */
export function isBiblicaBookMarkerStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "meta", "bk")
}

/**
 * Any `meta:*` paragraph — the book marker, the running heads, the table-of-
 * contents entries InDesign generates. None of them is text a reader sees.
 */
export function isBiblicaMetaStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "meta")
}

/**
 * Division headings (`intro:imt2`) open a section about a group of books —
 * "Israelʼs covenant history" before Genesis, "Israelʼs prophets" before
 * Isaiah, "Stories about Jesus" before Matthew. InDesign sets them inside the
 * following book's front matter, but they introduce the whole group, so they
 * belong to a section of their own rather than to that book's preface.
 */
export function isBiblicaDivisionHeadingStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "intro", "imt2")
}

/** Book titles (`intro:imt1`) open a book's preface, which ends a division. */
export function isBiblicaBookTitleStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "intro", "imt1")
}

/**
 * Major section headings (`head:ms1`). In a front/back matter volume each one
 * opens a section of the volume — the Bible Dictionary uses one per alphabet
 * letter — so they carve it into milestones the way chapters carve a book.
 */
export function isBiblicaMajorSectionHeadingStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "head", "ms1")
}

/**
 * Every heading that opens a section of a front/back matter volume: the major
 * section headings, the title-page heading (`title:mt1`) and the contents
 * heading (`toc:toc_hd`). Without the last two the whole title page and table
 * of contents would fall to whichever section opens after them.
 */
export function isBiblicaVolumeSectionHeadingStyle(paragraphStyle: string): boolean {
  return isBiblicaMajorSectionHeadingStyle(paragraphStyle)
    || hasStyleToken(paragraphStyle, "title", "mt1")
    || hasStyleToken(paragraphStyle, "toc", "toc_hd")
}

/**
 * Running heads (`meta:rh`) repeat the section marker and the page number on
 * every page. InDesign regenerates them from the layout, so they carry no
 * translatable text of their own.
 */
export function isBiblicaRunningHeadStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "meta", "rh")
}

/**
 * A heading's text as a section label. Soft hyphens are typesetting hints that
 * InDesign stores in the text itself ("Sto\u00adries about Jesus") and must not
 * reach a label the navigator shows.
 */
export function toBiblicaSectionLabel(headingText: string): string {
  return headingText.replace(/\u00ad/g, "").replace(/\s+/g, " ").trim()
}

/** Chapter-label headings such as "Psalm 2", which open a new chapter grouping. */
export function isBiblicaChapterHeadingStyle(paragraphStyle: string): boolean {
  return hasStyleToken(paragraphStyle, "head", "cl")
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
 * Chapter/verse delimiter runs (`meta:c`, `meta:v` and their `_sp` variants).
 *
 * InDesign flushes the closing markers of a book's final verse into the next
 * paragraph of the text flow — usually the following book's `intro:ie` — so
 * Matthew's closing "28:20" lands in Mark's preface, and a note that follows a
 * verse can end with a bare "21". The markers are invisible in the printed
 * layout and hold no translatable words, so they never belong to a note cell.
 * Unlike structural apostrophes they are never cleared on export: IDML needs
 * them to delimit verses, so their slots keep the publisher's text.
 */
export function isBiblicaVerseMarkerCharacterStyle(characterStyle: string): boolean {
  return VERSE_MARKER_STYLE_PATTERN.test(characterStyle)
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
