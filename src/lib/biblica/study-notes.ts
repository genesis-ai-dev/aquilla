/**
 * Select the study-note paragraphs from a fully parsed Biblica IDML package.
 *
 * The shared IDML engine parses every literal location in the document
 * losslessly, scripture included. A Biblica study-Bible import wants only the
 * `intro:*` note paragraphs: the Bible text itself is set from the publisher's
 * scripture files, not translated here. Verse runs are still walked, because
 * they are what tells us which book and chapter each note section belongs to.
 *
 * Note paragraphs are split at their line breaks, because Biblica sets lists —
 * cross-references, glossary entries, outlines — as a single paragraph with a
 * `<Br/>` between items. One cell per line is what a translator works in.
 *
 * This is a presentation filter over parsed units — it never reinterprets the
 * package. Every emitted note is an engine projection of its paragraph, so
 * protected-HTML editing and strict IDML export keep working on the original
 * bytes, with the parts of a split paragraph merged back on export.
 */

import { partitionIdmlUnitAtLineBreaks, type IdmlTranslationUnit } from "@aquilla/idml-roundtrip"
import {
  bookCodeFromParagraphText,
  computeChapterRangeLabel,
  isBiblicaBookMarkerStyle,
  isBiblicaChapterHeadingStyle,
  isBiblicaNoteSectionStyle,
  isChapterNumberCharacterStyle,
  isMetaChapterCharacterStyle,
  isMetaVerseCharacterStyle,
  isStructuralApostropheSegment,
  isStructuralOnlyContent,
  isVerseNumberCharacterStyle,
} from "./note-rules"

export interface BiblicaStudyNote {
  /**
   * The cell's unit: one line of a note paragraph, or the whole paragraph when
   * it holds no line break.
   */
  readonly unit: IdmlTranslationUnit
  /** Book the note belongs to, when the document has named one yet. */
  readonly bookCode?: string
  /** Chapter-range label for the note's section: "Preface", "3", or "1-2". */
  readonly chapterLabel: string
}

export interface BiblicaStudyNoteSelection {
  readonly notes: readonly BiblicaStudyNote[]
  /** Units skipped because they are scripture (verse markers or continuations). */
  readonly verseUnitCount: number
  /** Units skipped because they are neither scripture nor a note (headers, TOC). */
  readonly otherUnitCount: number
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

function noteHasVisibleText(unit: IdmlTranslationUnit): boolean {
  return unit.slots.some((slot) => (
    slot.text.trim().length > 0
    && !isStructuralApostropheSegment(slot.text, slot.characterStyleId)
  ))
}

export function selectBiblicaStudyNotes(
  units: readonly IdmlTranslationUnit[],
): BiblicaStudyNoteSelection {
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
  // Verse number still open across paragraph boundaries, if any.
  let openSpanningVerse: string | null = null

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
    }

    if (!currentBook) {
      const fallback = bookCodeFromParagraphText(unit.sourceText)
      if (fallback) currentBook = fallback
    }

    // Scripture paragraph: record which chapters it covered, then skip it.
    if (scan.verses.length > 0) {
      currentLabel = null
      for (const verse of scan.verses) updateChapterRange(verse.chapter)
      openSpanningVerse = opensSpanningVerse(scan) ?? null
      verseUnitCount += 1
      continue
    }

    // Continuation of a verse that began in an earlier paragraph.
    if (openSpanningVerse) {
      currentLabel = null
      updateChapterRange(currentChapter)
      if (scan.closesEarlierVerse && scan.metaVerseCounts.has(openSpanningVerse)) {
        openSpanningVerse = null
      }
      verseUnitCount += 1
      continue
    }

    // Only intro/* note styles become editable cells; running headers, tables of
    // contents and other furniture stay in the package untouched.
    if (!isBiblicaNoteSectionStyle(paragraphStyle)) {
      otherUnitCount += 1
      continue
    }
    if (isStructuralOnlyContent(unit.slots.map((slot) => slot.text)) || !noteHasVisibleText(unit)) {
      otherUnitCount += 1
      continue
    }

    // A chapter-label heading ("Psalm 2") opens a new chapter, so it and the
    // descriptions that follow group with the upcoming chapter, not the previous.
    if (isBiblicaChapterHeadingStyle(paragraphStyle)) {
      const headingChapter = unit.sourceText.replace(/\s+/g, " ").trim().match(/(\d+)\s*$/)
      if (headingChapter) {
        currentLabel = headingChapter[1]
        firstChapterInRange = null
        lastChapterInRange = null
      }
    }

    // First note paragraph after a verse section: compute the label once and
    // freeze it until the next verse section.
    if (currentLabel === null) {
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
        || !noteHasVisibleText(line)
      ) {
        continue
      }
      notes.push({
        unit: line,
        ...(currentBook ? { bookCode: currentBook } : {}),
        chapterLabel: currentLabel,
      })
    }
  }

  return { notes, verseUnitCount, otherUnitCount }
}
