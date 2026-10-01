/**
 * Treasure Hunt Bible IDML style rules.
 *
 * The Treasure Hunt Bible is a Biblica title, but its InDesign template shares
 * nothing with the study-Bible template the `../note-rules` module describes.
 * Where a study Bible marks notes positively (`intro:*`) and leaves everything
 * else alone, the Treasure Hunt template marks *scripture* positively and gives
 * every other kind of content its own family:
 *
 * - `pNormal`, `pStanzaLine1`, `pSectionHead`, `pTitleMain`, `pPsalmDescription`,
 *   `CHAP1pNormalAfterSectionHead`, … — the published NIrV text and its
 *   typesetting furniture. Always `p` + an uppercase letter, optionally behind a
 *   `CHAP1`/`CHAP2` drop-cap prefix.
 * - `!meta_par`, `!meta_fact_head`, `!hunt_list`, `!fact_par`, … — the Treasure
 *   Hunt apparatus: the facts, hunts and activities written for this edition.
 * - `_intro_head`, `_intro_book`, `_intro_list_lv1`, … — the per-book
 *   introductions.
 * - `par`, `fm_title`, `toc_l1`, `map_site`, `sign.book`, `wayees`, `bul` — front
 *   matter: copyright, contents, maps, signposts, character names.
 * - `#pn`, `#rh_recto`, `#rh_verso`, `zz.proof stages` — running heads, page
 *   numbers and production stamps, which are not content at all.
 *
 * So the import rule is the inverse of the study-Bible one: skip scripture and
 * skip furniture, and take everything else. Naming the two things we *don't*
 * want is what makes the importer survive the long tail — this edition uses over
 * 190 scripture paragraph styles and 40 apparatus styles, and new ones appear
 * per volume. An unrecognised apparatus style then arrives as a cell rather than
 * being silently dropped.
 */

import { matchLeadingBookName } from "../book-names"

/** InDesign ACE placeholder markers (page numbers, section markers, jumps). */
const ACE_MARKER_PATTERN = /<\?ACE\s+\d+\?>/gi

/**
 * Scripture paragraph styles: `p` + an uppercase letter, optionally behind the
 * `CHAP1`/`CHAP2` drop-cap prefix. `pNormal` and `pStanzaLine1` match; the front
 * matter's `par`, `par_next` and `par_head` do not, because their second
 * character is lowercase.
 */
const SCRIPTURE_STYLE_PATTERN = /^(?:CHAP\d+)?p[A-Z]/

/** InDesign's own placeholder for the scripture body style, used by empty frames. */
const SCRIPTURE_PLACEHOLDER_STYLES: ReadonlySet<string> = new Set(["*pNormal*"])

/**
 * Page numbers and running heads (`#pn`, `#rh_recto`, `#rh_verso`), production
 * proof stamps (`zz.proof stages`), and InDesign's unnamed default.
 */
const FURNITURE_STYLE_PATTERN = /^(?:#|zz\.)/

const FURNITURE_STYLES: ReadonlySet<string> = new Set([
  "*DEFAULT PARAGRAPH*",
  "$ID/[No paragraph style]",
])

/** Running-head separator glyph, the only visible text in a `#rh_*` frame. */
const RUNNING_HEAD_GLYPH_PATTERN = /^[|\s]+$/

export type TreasureHuntUnitKind = "scripture" | "furniture" | "content"

/**
 * The style name on its own: the engine reports the applied style as InDesign
 * writes it, `ParagraphStyle/!meta_par`, and URL-encodes characters that are
 * illegal in that path, so `!meta` can also arrive as `%21meta`. Both are
 * undone here rather than pattern-matched in every rule, because these names
 * carry `!`, `#`, `.` and `$` in combination.
 */
export function decodeStyleName(styleName: string): string {
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

/** True for the published NIrV text and the headings set with it. */
export function isTreasureHuntScriptureStyle(paragraphStyle: string): boolean {
  const name = decodeStyleName(paragraphStyle)
  return SCRIPTURE_STYLE_PATTERN.test(name) || SCRIPTURE_PLACEHOLDER_STYLES.has(name)
}

/** True for page numbers, running heads and production stamps. */
export function isTreasureHuntFurnitureStyle(paragraphStyle: string): boolean {
  const name = decodeStyleName(paragraphStyle)
  return FURNITURE_STYLE_PATTERN.test(name) || FURNITURE_STYLES.has(name)
}

/** True for the `!meta_*` / `!hunt_*` / `!fact_*` Treasure Hunt apparatus. */
export function isTreasureHuntApparatusStyle(paragraphStyle: string): boolean {
  return decodeStyleName(paragraphStyle).startsWith("!")
}

/** True for the per-book introduction styles (`_intro_head`, `_intro_book`, …). */
export function isTreasureHuntIntroStyle(paragraphStyle: string): boolean {
  return decodeStyleName(paragraphStyle).startsWith("_intro")
}

/**
 * True for the reference heading that opens a fact or hunt block — `!meta_fact_head`,
 * `!meta_hunt_head`, `!fact_head`. Its text is the passage the block is about.
 */
export function isTreasureHuntBlockHeadStyle(paragraphStyle: string): boolean {
  const name = decodeStyleName(paragraphStyle)
  return name.startsWith("!") && name.endsWith("_head")
}

/** True for the paragraph naming the book an introduction belongs to. */
export function isTreasureHuntBookNameStyle(paragraphStyle: string): boolean {
  const name = decodeStyleName(paragraphStyle)
  return name === "_intro_book" || name === "_intro_book_long"
}

/**
 * Which of the three buckets a paragraph falls into. Anything that is neither
 * scripture nor furniture is content, so an unrecognised apparatus or
 * front-matter style is imported instead of dropped.
 */
export function classifyTreasureHuntUnit(paragraphStyle: string): TreasureHuntUnitKind {
  if (isTreasureHuntScriptureStyle(paragraphStyle)) return "scripture"
  if (isTreasureHuntFurnitureStyle(paragraphStyle)) return "furniture"
  return "content"
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

/**
 * True for a frame holding only the `|` glyph that separates the two halves of a
 * running head. These carry a content style in some volumes, so the glyph itself
 * is what disqualifies them.
 */
export function isRunningHeadGlyph(text: string): boolean {
  const trimmed = text.replace(ACE_MARKER_PATTERN, "").trim()
  return trimmed.length > 0 && RUNNING_HEAD_GLYPH_PATTERN.test(trimmed)
}

/** Any dash InDesign may set between two chapter or verse numbers. */
const DASH_CLASS = "\\u2010-\\u2015\\u2212-"

export interface TreasureHuntReference {
  /** USFM code for the book the heading names. */
  readonly bookCode: string
  /** First chapter mentioned, when the heading gives one. */
  readonly chapter?: string
  /** Last chapter mentioned, when the heading spans several. */
  readonly lastChapter?: string
}

/**
 * Read the passage a Treasure Hunt fact or hunt heading points at.
 *
 * The headings are plain references written the way a reader would say them:
 * "Genesis 1", "Genesis 2:8−15", "1 Chronicles 16:8–30, 36",
 * "Genesis 7:12, 17, 24, 8:3−14", "1 Corinthians 13 – 14". Only the book and the
 * chapter span matter here, because that is what the navigator groups by;
 * verses are read solely to find chapters they qualify.
 */
export function parseTreasureHuntReference(text: string): TreasureHuntReference | undefined {
  const normalized = text.replace(/\s+/g, " ").trim()
  const match = matchLeadingBookName(normalized)
  if (!match) return undefined

  const chapters = chapterNumbers(normalized.slice(match.name.length))
  if (chapters.length === 0) return { bookCode: match.bookCode }

  const first = chapters[0]
  const last = chapters[chapters.length - 1]
  return {
    bookCode: match.bookCode,
    chapter: first,
    ...(last !== first ? { lastChapter: last } : {}),
  }
}

/**
 * Chapter numbers in a reference tail, in the order they appear.
 *
 * A number is a chapter when it is followed by `:` ("8:3"), or when it stands
 * alone with no verse part at all ("Genesis 1", "1 Corinthians 13 – 14"). A
 * number after a colon or inside a verse list is a verse and is skipped, so
 * "16:8–30, 36" yields chapter 16 only.
 */
function chapterNumbers(tail: string): string[] {
  const chapters: string[] = []
  // Each match is one number plus whatever separates it from the next token, so
  // the loop can tell "8:" (chapter) from "8," and "8–" (verse continuation).
  const tokens = tail.matchAll(
    new RegExp(`(\\d+)\\s*([:.,;${DASH_CLASS}]|$|\\s)`, "gu"),
  )
  let inVerseList = false
  for (const token of tokens) {
    const number = token[1]
    const separator = token[2] ?? ""
    if (separator === ":" || separator === ".") {
      chapters.push(number)
      inVerseList = true
      continue
    }
    // A bare number that no colon has claimed is a whole-chapter reference.
    if (!inVerseList) chapters.push(number)
  }
  return chapters
}

/**
 * The section label for a note, given the reference its block heading carried.
 * "Genesis 1" becomes "1", "Genesis 1 – 3" becomes "1-3", and a heading that
 * named only the book (or a note that has no heading yet) becomes "Intro".
 */
export function treasureHuntChapterLabel(reference: TreasureHuntReference | undefined): string {
  if (!reference?.chapter) return "Intro"
  return reference.lastChapter
    ? `${reference.chapter}-${reference.lastChapter}`
    : reference.chapter
}
