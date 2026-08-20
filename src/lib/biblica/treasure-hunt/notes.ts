/**
 * Select the Treasure Hunt content from a fully parsed IDML package.
 *
 * The shared IDML engine parses every literal location in the document
 * losslessly, scripture included. A Treasure Hunt import wants everything set
 * *around* the Bible text — the fact and hunt blocks, the per-book
 * introductions, and the front matter (contents, copyright, maps, signposts,
 * character names) — and none of the NIrV text itself, which is set from the
 * publisher's scripture files rather than retyped here.
 *
 * Unlike the study-Bible importer, which recognises notes positively by their
 * `intro:*` style, this one recognises *scripture* and page furniture and takes
 * the rest (see `./note-rules`). The edition uses over 190 scripture paragraph
 * styles and a long tail of apparatus styles that varies per volume, so an
 * unrecognised style is far more likely to be a new kind of note than a new kind
 * of scripture — and arriving as a cell is the recoverable outcome.
 *
 * Content paragraphs are always split at line breaks, because this template sets
 * lists — hunt steps, fact bullets, contents entries — as a single paragraph
 * with a `<Br/>` between items. Sentence splitting within each line is optional
 * (`splitSentences`, on by default).
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
} from "@aquilla/idml-roundtrip"
import { treasureHuntSentenceCutPoints } from "./sentence-cuts"
import {
  classifyTreasureHuntUnit,
  isRunningHeadGlyph,
  isStructuralOnlyContent,
  isTreasureHuntApparatusStyle,
  isTreasureHuntBlockHeadStyle,
  isTreasureHuntBookNameStyle,
  isTreasureHuntIntroStyle,
  parseTreasureHuntReference,
  treasureHuntChapterLabel,
  type TreasureHuntReference,
} from "./note-rules"

/** Which part of the edition a cell came from, for section labels and grouping. */
export type TreasureHuntContentType = "hunt" | "intro" | "front-matter"

export interface TreasureHuntNote {
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
  readonly rejoin?: TreasureHuntNoteRejoin
  /** Book the note belongs to, when the document has named one yet. */
  readonly bookCode?: string
  /** Chapter-range label for the note's block: "Intro", "3", or "1-2". */
  readonly chapterLabel: string
  readonly contentType: TreasureHuntContentType
}

export interface TreasureHuntNoteRejoin {
  readonly index: number
  readonly count: number
  readonly ranges: readonly IdmlSliceRange[]
}

export interface TreasureHuntSelection {
  readonly notes: readonly TreasureHuntNote[]
  /** Units skipped because they are the published Bible text. */
  readonly scriptureUnitCount: number
  /** Units skipped because they are page furniture or hold no visible text. */
  readonly otherUnitCount: number
}

export interface SelectTreasureHuntNotesOptions {
  /**
   * When true (default), cut each line at sentence boundaries so long blocks
   * arrive as one cell per sentence. When false, each line is one cell.
   */
  readonly splitSentences?: boolean
}

/** The coordinate space sentence cuts are expressed in: slot text, nothing else. */
function slotText(unit: IdmlTranslationUnit): string {
  return unit.slots.map((slot) => slot.text).join("")
}

function hasVisibleText(unit: IdmlTranslationUnit): boolean {
  return !isStructuralOnlyContent(unit.slots.map((slot) => slot.text))
    && !isRunningHeadGlyph(slotText(unit))
}

function contentTypeFor(paragraphStyle: string): TreasureHuntContentType {
  if (isTreasureHuntApparatusStyle(paragraphStyle)) return "hunt"
  if (isTreasureHuntIntroStyle(paragraphStyle)) return "intro"
  return "front-matter"
}

interface PlacedUnit {
  readonly unit: IdmlTranslationUnit
  readonly contentType: TreasureHuntContentType
  bookCode: string
  reference: TreasureHuntReference | undefined
}

/**
 * Which passage each content paragraph belongs to, in document order.
 *
 * Fact and hunt headings carry a reference and re-anchor everything that
 * follows. A book-name paragraph opens that book's introduction, which has no
 * chapter yet. Introductions and front matter carry no reference of their own,
 * so they inherit whatever is in effect.
 */
function placeContentUnits(units: readonly IdmlTranslationUnit[]): {
  placed: PlacedUnit[]
  scriptureUnitCount: number
  otherUnitCount: number
} {
  const placed: PlacedUnit[] = []
  let scriptureUnitCount = 0
  let otherUnitCount = 0
  let currentBook = ""
  let currentReference: TreasureHuntReference | undefined

  for (const unit of units) {
    const paragraphStyle = unit.paragraphStyleId ?? ""
    const kind = classifyTreasureHuntUnit(paragraphStyle)

    if (kind === "scripture") {
      scriptureUnitCount += 1
      continue
    }
    if (kind === "furniture" || !hasVisibleText(unit)) {
      otherUnitCount += 1
      continue
    }

    // Read a heading before placing it, so it belongs to the passage it
    // introduces rather than to the one before it.
    if (isTreasureHuntBlockHeadStyle(paragraphStyle)) {
      const reference = parseTreasureHuntReference(unit.sourceText)
      if (reference) {
        currentReference = reference
        currentBook = reference.bookCode
      }
    }

    if (isTreasureHuntBookNameStyle(paragraphStyle)) {
      const reference = parseTreasureHuntReference(unit.sourceText)
      if (reference) {
        currentBook = reference.bookCode
        currentReference = { bookCode: reference.bookCode }
        // The book's introduction opens with a section heading ("Israel's
        // covenant history") set *before* the title paragraph, and the package
        // also carries the previous books' thumb-tab labels ahead of all of
        // them. Nothing before the title says which book is coming, so the
        // introduction paragraphs directly above it are claimed here instead of
        // guessed at. The walk stops at the first paragraph that belongs to
        // something else: a fact or hunt of the previous book, front matter, or
        // another book's own title.
        for (let index = placed.length - 1; index >= 0; index -= 1) {
          const earlier = placed[index]!
          if (earlier.contentType !== "intro") break
          if (isTreasureHuntBookNameStyle(earlier.unit.paragraphStyleId ?? "")) break
          earlier.bookCode = reference.bookCode
          earlier.reference = { bookCode: reference.bookCode }
        }
      }
    }

    placed.push({
      unit,
      contentType: contentTypeFor(paragraphStyle),
      bookCode: currentBook,
      reference: currentReference,
    })
  }

  return { placed, scriptureUnitCount, otherUnitCount }
}

export function selectTreasureHuntNotes(
  units: readonly IdmlTranslationUnit[],
  options?: SelectTreasureHuntNotesOptions,
): TreasureHuntSelection {
  const splitSentences = options?.splitSentences !== false
  const { placed, scriptureUnitCount, otherUnitCount } = placeContentUnits(units)
  const notes: TreasureHuntNote[] = []

  for (const entry of placed) {
    const chapterLabel = treasureHuntChapterLabel(entry.reference)
    const common = {
      ...(entry.bookCode ? { bookCode: entry.bookCode } : {}),
      chapterLabel,
      contentType: entry.contentType,
    }

    // One cell per line: a hunt's steps set as a single paragraph would
    // otherwise arrive as one cell holding every step. Lines that are only
    // structural glue own no cell, and their slots keep their source text on
    // export.
    for (const line of partitionIdmlUnitAtLineBreaks(entry.unit)) {
      if (!hasVisibleText(line)) continue
      if (!splitSentences) {
        notes.push({ unit: line, ...common })
        continue
      }

      // One cell per sentence. Slices are kept whole and in order, however
      // little text a slice holds, because their ranges have to tile the line
      // for the exporter to rebuild it.
      const slices = sliceIdmlUnit(line, treasureHuntSentenceCutPoints(slotText(line)))
      for (const [index, slice] of slices.entries()) {
        notes.push({
          unit: slice.unit,
          ...(slices.length > 1
            ? { rejoin: { index, count: slices.length, ranges: slice.ranges } }
            : {}),
          ...common,
        })
      }
    }
  }

  return { notes, scriptureUnitCount, otherUnitCount }
}
