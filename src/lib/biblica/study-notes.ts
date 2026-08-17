/**
 * Select the study-note paragraphs from a fully parsed Biblica IDML package.
 *
 * The shared IDML engine parses every literal location in the document
 * losslessly, scripture included. A Biblica study-Bible import wants only the
 * `intro:*` note paragraphs: the Bible text itself is set from the publisher's
 * scripture files, not translated here. Verse runs are still walked, because
 * they are what tells us which book and chapter each note section belongs to.
 *
 * Biblica also ships the study Bible's front and back matter — title pages and
 * contents, "how to use", the Bible Dictionary, the timelines, the maps, the
 * cover — as separate volumes that hold no scripture at all and set their text
 * in layout styles rather than in `intro:*`. Those read in front/back matter
 * mode (`frontBackMatter`), where every text-bearing paragraph is a cell and
 * only InDesign's regenerated running heads are left out.
 *
 * Cells group under the section they belong to. In a book volume that is the
 * chapter range the notes comment on, except for a division heading
 * (`intro:imt2`) such as "Israelʼs covenant history", which introduces a group
 * of books and so opens a section of its own until the next book title. A
 * front/back volume has no chapters, so its sections come from its headings.
 *
 * The chapter/verse delimiters InDesign leaves inside note paragraphs are cut
 * out of the cells (see `isBiblicaVerseMarkerCharacterStyle`): a preface that
 * ends with the previous book's "28:20" holds no translatable words there, and
 * a paragraph that is nothing but those markers owns no cell at all.
 *
 * Note paragraphs are always split at line breaks, because Biblica sets lists —
 * cross-references, glossary entries, outlines — as a single paragraph with a
 * `<Br/>` between items. Sentence splitting within each line is optional
 * (`splitSentences`, off by default): when enabled, a multi-sentence note block
 * becomes one cell per sentence; when off, each line stays one cell.
 *
 * This is a presentation filter over parsed units — it never reinterprets the
 * package. Every emitted note is an engine projection or slice of its paragraph,
 * so protected-HTML editing keeps working on the original bytes: line parts are
 * real locators the engine merges on export, and sentence slices carry the
 * `rejoin` ranges the exporter uses to rebuild their line first.
 */

import {
  partitionIdmlUnitAtLineBreaks,
  sliceIdmlUnit,
  type IdmlSliceRange,
  type IdmlTranslationUnit,
  type IdmlUnitSlice,
} from "@aquilla/idml-roundtrip"
import { biblicaSentenceCutPoints } from "./sentence-cuts"
import {
  bookCodeFromParagraphText,
  computeChapterRangeLabel,
  isBiblicaBookMarkerStyle,
  isBiblicaBookTitleStyle,
  isBiblicaChapterHeadingStyle,
  isBiblicaDivisionHeadingStyle,
  isBiblicaMetaStyle,
  isBiblicaNoteSectionStyle,
  isBiblicaRunningHeadStyle,
  isBiblicaVerseMarkerCharacterStyle,
  isBiblicaStudyTemplateStyle,
  isBiblicaVolumeSectionHeadingStyle,
  isChapterNumberCharacterStyle,
  isMetaChapterCharacterStyle,
  isMetaVerseCharacterStyle,
  isStructuralApostropheSegment,
  isStructuralOnlyContent,
  isUnnamedParagraphStyle,
  isVerseNumberCharacterStyle,
  toBiblicaSectionLabel,
} from "./note-rules"

export interface BiblicaStudyNote {
  /**
   * The cell's unit: one sentence of a note line, one whole line, or the whole
   * paragraph when it holds neither a line break nor a sentence boundary.
   */
  readonly unit: IdmlTranslationUnit
  /**
   * Set when the unit is one sentence of a larger line, which the exporter has
   * to rebuild before handing the line to the engine. Absent when the unit is
   * the whole thing its locator addresses.
   */
  readonly rejoin?: BiblicaNoteRejoin
  /** Book the note belongs to, when the document has named one yet. */
  readonly bookCode?: string
  /**
   * Chapter-range label for the note's section: "Preface", "3", or "1-2".
   * Absent for a cell that belongs to a heading-titled section instead — a
   * division, or any section of a front/back matter volume.
   */
  readonly chapterLabel?: string
  /** Heading-titled section the cell belongs to, when it is in one. */
  readonly section?: BiblicaNoteSection
}

/** A section opened by a heading rather than by the passage the notes follow. */
export interface BiblicaNoteSection {
  /** Stable within one package: the heading's position and its text. */
  readonly id: string
  readonly label: string
}

export interface BiblicaNoteRejoin {
  readonly index: number
  readonly count: number
  readonly ranges: readonly IdmlSliceRange[]
}

export interface BiblicaStudyNoteSelection {
  readonly notes: readonly BiblicaStudyNote[]
  /** Units skipped because they are scripture (verse markers or continuations). */
  readonly verseUnitCount: number
  /** Units skipped because they are neither scripture nor a note (headers, TOC). */
  readonly otherUnitCount: number
}

export interface SelectBiblicaStudyNotesOptions {
  /**
   * When true, cut each line at sentence boundaries so long note
   * blocks arrive as one cell per sentence. When false, each line is one cell.
   */
  readonly splitSentences?: boolean
  /**
   * Read the package as a front/back matter volume: take every text-bearing
   * paragraph rather than only the `intro:*` notes, and group by heading
   * instead of by chapter. Callers get this from
   * `isBiblicaFrontBackMatterPackage`, which is what the volumes themselves
   * say — they carry no scripture at all.
   */
  readonly frontBackMatter?: boolean
}

interface UnitScan {
  /** Chapter in effect after walking this unit. */
  readonly chapter: string
  /** Verse markers in document order, each with the chapter in effect. */
  readonly verses: readonly { readonly chapter: string; readonly verse: string }[]
  /** How many `meta:v` bookends carry each verse number. */
  readonly metaVerseCounts: ReadonlyMap<string, number>
  /** True when a `meta:v` bookend precedes any verse marker in this unit. */
  readonly closesEarlierVerse: boolean
  /** Book abbreviation, for a `meta:bk` paragraph. */
  readonly bookCode?: string
}

/**
 * A `meta:bk` paragraph's text is the book abbreviation, but InDesign may split
 * it across several `<Content>` runs, so read the joined unit text.
 */
function bookMarkerCode(unit: IdmlTranslationUnit): string | undefined {
  const abbreviation = unit.sourceText.replace(/\s+/g, "")
  return abbreviation.length >= 2 && abbreviation.length <= 4 ? abbreviation : undefined
}

function scanUnit(unit: IdmlTranslationUnit, chapterAtStart: string): UnitScan {
  const paragraphStyle = unit.paragraphStyleId ?? ""
  let chapter = chapterAtStart
  const verses: { chapter: string; verse: string }[] = []
  const metaVerseCounts = new Map<string, number>()
  let closesEarlierVerse = false

  for (const slot of unit.slots) {
    const style = slot.characterStyleId
    const text = slot.text.trim()

    // Drop-cap chapter numbers ("1", "2", …) and Psalms-style chapter meta
    // markers ("1:") both re-anchor the chapter mid-paragraph.
    if (isChapterNumberCharacterStyle(style)) {
      if (/^\d+$/.test(text)) chapter = text
      continue
    }
    if (isMetaChapterCharacterStyle(style)) {
      const match = text.match(/^(\d+)/)
      if (match) chapter = match[1]
      continue
    }
    if (isMetaVerseCharacterStyle(style)) {
      const match = text.match(/^(\d+)/)
      if (!match) continue
      const verseNumber = match[1]
      metaVerseCounts.set(verseNumber, (metaVerseCounts.get(verseNumber) ?? 0) + 1)
      if (verses.length === 0) closesEarlierVerse = true
      continue
    }
    if (isVerseNumberCharacterStyle(style)) {
      const match = text.match(/^(\d+)/)
      if (match) verses.push({ chapter, verse: match[1] })
    }
  }

  return {
    chapter,
    verses,
    metaVerseCounts,
    closesEarlierVerse,
    ...(isBiblicaBookMarkerStyle(paragraphStyle)
      ? { bookCode: bookMarkerCode(unit) }
      : {}),
  }
}

/**
 * A verse whose opening `meta:v` bookend has no matching closing bookend in the
 * same paragraph continues into the paragraphs that follow. The structure is
 * `[cv:v N][meta:v N] … text … [meta:v N]`, so a single `meta:v N` means the
 * verse is still open.
 */
function opensSpanningVerse(scan: UnitScan): string | undefined {
  const last = scan.verses[scan.verses.length - 1]
  if (!last) return undefined
  return scan.metaVerseCounts.get(last.verse) === 1 ? last.verse : undefined
}

/** The coordinate space sentence cuts are expressed in: slot text, nothing else. */
function slotText(unit: IdmlTranslationUnit): string {
  return unit.slots.map((slot) => slot.text).join("")
}

/** Slot positions holding a chapter/verse delimiter rather than note text. */
function verseMarkerSlots(unit: IdmlTranslationUnit): ReadonlySet<number> {
  const positions = new Set<number>()
  for (const [position, slot] of unit.slots.entries()) {
    if (isBiblicaVerseMarkerCharacterStyle(slot.characterStyleId)) positions.add(position)
  }
  return positions
}

/**
 * Cuts that put every delimiter run in a slice of its own, in the slot-text
 * coordinates the sentence cutter also works in.
 */
function verseMarkerCutPoints(
  unit: IdmlTranslationUnit,
  markers: ReadonlySet<number>,
): number[] {
  const cuts: number[] = []
  let offset = 0
  for (const [position, slot] of unit.slots.entries()) {
    const start = offset
    offset += slot.text.length
    if (slot.text.length > 0 && markers.has(position)) cuts.push(start, offset)
  }
  return cuts
}

/** True for a slice that holds delimiters and no words of its own. */
function isVerseMarkerSlice(slice: IdmlUnitSlice, markers: ReadonlySet<number>): boolean {
  if (!slice.ranges.some((range) => markers.has(range.slot))) return false
  return !slice.ranges.some((range, position) => (
    !markers.has(range.slot) && (slice.unit.slots[position]?.text.trim().length ?? 0) > 0
  ))
}

/**
 * True when a paragraph holds words of its own.
 *
 * A book volume hides the "source serif" apostrophe slots, which are InDesign
 * glue rather than text, so a paragraph made only of them owns no cell. Front
 * and back matter is prose-heavy English where those slots are ordinary
 * possessives and contractions, so there they count as text like any other.
 */
function noteHasVisibleText(unit: IdmlTranslationUnit, frontBackMatter: boolean): boolean {
  const markers = verseMarkerSlots(unit)
  return unit.slots.some((slot, position) => (
    slot.text.trim().length > 0
    && !markers.has(position)
    && (frontBackMatter || !isStructuralApostropheSegment(slot.text, slot.characterStyleId))
  ))
}

/**
 * True when a package is one of the study Bible's front/back matter volumes:
 * title pages and contents, "how to use", the Bible Dictionary, the timelines,
 * the maps, the cover.
 *
 * Nothing in a package names its own kind, so this reads what the volumes do
 * and do not contain. A front/back volume holds no verse markers and no
 * `meta:bk` book marker — it is not scoped to a book at all — and it sets its
 * text in layout styles (`text:*`, `toc:*`, `title:*`, `Box Text`, the default
 * paragraph style) rather than in the `intro:*` notes. A book volume fails all
 * three: its notes sit beside the verses they comment on.
 *
 * A volume that parses to nothing is the maps or a plate section — pure
 * artwork, and front/back matter by elimination.
 *
 * Biblica's other titles hold no verse markers of this kind either, so the
 * volume also has to be built from the study-Bible template — or, like the
 * cover, from no template at all. Otherwise a Treasure Hunt or Reach 4 Life
 * package would import here instead of being sent to its own importer.
 */
export function isBiblicaFrontBackMatterPackage(
  units: readonly IdmlTranslationUnit[],
): boolean {
  if (units.length === 0) return true
  let hasLayoutText = false
  let hasStudyTemplateStyle = false
  let hasForeignTemplateStyle = false
  for (const unit of units) {
    const paragraphStyle = unit.paragraphStyleId ?? ""
    if (isBiblicaBookMarkerStyle(paragraphStyle)) return false
    if (unit.slots.some((slot) => (
      isVerseNumberCharacterStyle(slot.characterStyleId)
      || isMetaVerseCharacterStyle(slot.characterStyleId)
    ))) {
      return false
    }
    if (isBiblicaStudyTemplateStyle(paragraphStyle)) hasStudyTemplateStyle = true
    else if (!isUnnamedParagraphStyle(paragraphStyle)) hasForeignTemplateStyle = true
    if (
      !isBiblicaNoteSectionStyle(paragraphStyle)
      && !isBiblicaMetaStyle(paragraphStyle)
      && !isStructuralOnlyContent(unit.slots.map((slot) => slot.text))
    ) {
      hasLayoutText = true
    }
  }
  return hasLayoutText && (hasStudyTemplateStyle || !hasForeignTemplateStyle)
}

export function selectBiblicaStudyNotes(
  units: readonly IdmlTranslationUnit[],
  options?: SelectBiblicaStudyNotesOptions,
): BiblicaStudyNoteSelection {
  const splitSentences = options?.splitSentences === true
  const frontBackMatter = options?.frontBackMatter === true
  const notes: BiblicaStudyNote[] = []
  let verseUnitCount = 0
  let otherUnitCount = 0

  let currentBook = ""
  let currentChapter = "1"
  let hasEncounteredVerses = false

  // Chapter-range tracking for note-section labels: the first and latest
  // chapters seen in verse paragraphs since the previous note section.
  let firstChapterInRange: string | null = null
  let lastChapterInRange: string | null = null
  // Frozen label for the note section currently being emitted.
  let currentLabel: string | null = null
  // Heading-titled section currently open, if any, and how many have opened so
  // far — the count is what keeps two sections with the same heading apart.
  let currentSection: BiblicaNoteSection | null = null
  let sectionCount = 0
  // Verse number still open across paragraph boundaries, if any.
  let openSpanningVerse: string | null = null

  // A heading InDesign broke over several lines reads as one label, with the
  // breaks as spaces — otherwise "The Drama of the Bible" and the subtitle
  // under it run together into one word.
  const openSection = (unit: IdmlTranslationUnit): BiblicaNoteSection | null => {
    const label = toBiblicaSectionLabel(
      partitionIdmlUnitAtLineBreaks(unit).map((line) => line.sourceText).join(" "),
    )
    if (!label) return null
    sectionCount += 1
    return { id: `${sectionCount}:${label}`, label }
  }

  const updateChapterRange = (chapter: string): void => {
    if (!firstChapterInRange) firstChapterInRange = chapter
    lastChapterInRange = chapter
    hasEncounteredVerses = true
  }

  for (const unit of units) {
    const paragraphStyle = unit.paragraphStyleId ?? ""

    // A note section or a new book ends any verse that was still open, so those
    // paragraphs are never treated as scripture continuations.
    if (isBiblicaNoteSectionStyle(paragraphStyle) || isBiblicaBookMarkerStyle(paragraphStyle)) {
      openSpanningVerse = null
    }

    const scan = scanUnit(unit, currentChapter)
    currentChapter = scan.chapter

    if (scan.bookCode && scan.bookCode !== currentBook) {
      currentBook = scan.bookCode
      currentChapter = "1"
      hasEncounteredVerses = false
      firstChapterInRange = null
      lastChapterInRange = null
      currentLabel = null
      currentSection = null
    }

    // Some packages omit meta:bk and name the book in a structural running
    // heading instead. Never infer a book from an editable note itself: a
    // document-level preface may begin with "ISA — …" and must remain the
    // standalone Preface until the real book boundary arrives. Front and back
    // matter is not scoped to a book at all, and its layout text — contents
    // lines, dictionary entries — can read like a book code by accident.
    if (!currentBook && !frontBackMatter && !isBiblicaNoteSectionStyle(paragraphStyle)) {
      const fallback = bookCodeFromParagraphText(unit.sourceText)
      if (fallback) currentBook = fallback
    }

    // Scripture paragraph: record which chapters it covered, then skip it.
    if (scan.verses.length > 0) {
      currentLabel = null
      currentSection = null
      for (const verse of scan.verses) updateChapterRange(verse.chapter)
      openSpanningVerse = opensSpanningVerse(scan) ?? null
      verseUnitCount += 1
      continue
    }

    // Continuation of a verse that began in an earlier paragraph.
    if (openSpanningVerse) {
      currentLabel = null
      currentSection = null
      updateChapterRange(currentChapter)
      if (scan.closesEarlierVerse && scan.metaVerseCounts.has(openSpanningVerse)) {
        openSpanningVerse = null
      }
      verseUnitCount += 1
      continue
    }

    // In a book volume only intro/* note styles become editable cells; running
    // headers, tables of contents and other furniture stay in the package
    // untouched. A front/back volume sets its text in layout styles instead, so
    // there every paragraph is a cell except the running heads InDesign
    // regenerates from the layout.
    const isFurniture = frontBackMatter
      ? isBiblicaRunningHeadStyle(paragraphStyle)
      : !isBiblicaNoteSectionStyle(paragraphStyle)
    if (isFurniture) {
      otherUnitCount += 1
      continue
    }
    if (
      isStructuralOnlyContent(unit.slots.map((slot) => slot.text))
      || !noteHasVisibleText(unit, frontBackMatter)
    ) {
      otherUnitCount += 1
      continue
    }

    // A division heading opens a section about a group of books, which runs
    // until the book title that follows it. Its cells belong to the group, not
    // to that book, so they carry neither the book nor a chapter range.
    if (isBiblicaDivisionHeadingStyle(paragraphStyle)) {
      const section = openSection(unit)
      if (section) {
        currentSection = section
        currentLabel = null
        firstChapterInRange = null
        lastChapterInRange = null
      }
    } else if (currentSection && !frontBackMatter && isBiblicaBookTitleStyle(paragraphStyle)) {
      currentSection = null
    }

    // A volume's own headings carve it into sections the way chapters carve a
    // book — one per alphabet letter in the Bible Dictionary. The heading keeps
    // a cell of its own so its text stays translatable.
    if (frontBackMatter && isBiblicaVolumeSectionHeadingStyle(paragraphStyle)) {
      const section = openSection(unit)
      if (section) currentSection = section
    }

    // A chapter-label heading ("Psalm 2") opens a new chapter, so it and the
    // descriptions that follow group with the upcoming chapter, not the previous.
    if (isBiblicaChapterHeadingStyle(paragraphStyle)) {
      const headingChapter = unit.sourceText.replace(/\s+/g, " ").trim().match(/(\d+)\s*$/)
      if (headingChapter) {
        currentSection = null
        currentLabel = headingChapter[1]
        firstChapterInRange = null
        lastChapterInRange = null
      }
    }

    // First note paragraph after a verse section: compute the label once and
    // freeze it until the next verse section. A cell inside a heading-titled
    // section has no chapter range to compute, and front/back matter has no
    // chapters at all — its paragraphs ahead of the first heading stay
    // unlabelled and group with the volume's opening milestone.
    if (currentLabel === null && !currentSection && !frontBackMatter) {
      currentLabel = computeChapterRangeLabel(
        firstChapterInRange,
        lastChapterInRange,
        hasEncounteredVerses,
      )
      firstChapterInRange = null
      lastChapterInRange = null
    }

    // One cell per line: a list set as a single paragraph would otherwise arrive
    // as one cell holding every item. Lines that are only structural glue own no
    // cell, and their slots keep their source text on export.
    for (const line of partitionIdmlUnitAtLineBreaks(unit)) {
      if (
        isStructuralOnlyContent(line.slots.map((slot) => slot.text))
        || !noteHasVisibleText(line, frontBackMatter)
      ) {
        continue
      }
      // One cell per sentence when splitting is on, and in either mode the
      // chapter/verse delimiters are cut away from the words around them.
      // Sentence slices are kept whole and in order, however little text a slice
      // holds; only the delimiter slices are dropped, and the exporter keeps the
      // publisher's text wherever no cell covers the line.
      const markers = verseMarkerSlots(line)
      const slices = sliceIdmlUnit(line, [
        ...(splitSentences ? biblicaSentenceCutPoints(slotText(line)) : []),
        ...verseMarkerCutPoints(line, markers),
      ])
      const cells = slices.filter((slice) => !isVerseMarkerSlice(slice, markers))
      // A cell that is not the whole line has to record which part of it it owns,
      // even when it is the only one left after the delimiters were dropped.
      const isPartOfLine = cells.length > 1 || cells.length !== slices.length
      for (const [index, slice] of cells.entries()) {
        notes.push({
          unit: slice.unit,
          ...(isPartOfLine
            ? { rejoin: { index, count: cells.length, ranges: slice.ranges } }
            : {}),
          // A division describes several books, so its cells name none of them.
          ...(currentBook && !currentSection ? { bookCode: currentBook } : {}),
          ...(currentSection ? { section: currentSection } : {}),
          ...(currentLabel !== null ? { chapterLabel: currentLabel } : {}),
        })
      }
    }
  }

  return { notes, verseUnitCount, otherUnitCount }
}
