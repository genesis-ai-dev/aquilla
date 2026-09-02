/**
 * Select the Reach4Life content from a fully parsed IDML package.
 *
 * The shared IDML engine parses every literal location in the document
 * losslessly, scripture included. A Reach4Life import wants the workbook set
 * *around* the Bible text — the lessons and journeys, the hot topics, the
 * per-book introductions, the contents and copyright — and none of the NIrV
 * text itself, which is set from the publisher's scripture files rather than
 * retyped here.
 *
 * The verses quoted *inside* a lesson are a deliberate exception: they are part
 * of the lesson's layout, sit under the lesson's own style group, and a
 * translator needs the verse in place beside the teaching it supports. Only
 * continuous scripture — the Bible volumes and the Psalms reading — is skipped
 * (see `./note-rules`).
 *
 * Content paragraphs are always split at line breaks, because this template
 * sets lists — journey steps, contents entries, bullet advice — as a single
 * paragraph with a `<Br/>` between items. Sentence splitting within each line is
 * optional (`splitSentences`, on by default).
 *
 * This is a presentation filter over parsed units — it never reinterprets the
 * package. Every emitted cell is an engine projection or slice of its paragraph,
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
import { reach4LifeSentenceCutPoints } from "./sentence-cuts"
import {
  classifyReach4LifeUnit,
  contentTypeForSection,
  isBookIntroSection,
  isReach4LifeBookStraplineStyle,
  isReach4LifeBookTitleStyle,
  isRunningHeadGlyph,
  isStructuralOnlyContent,
  parseReach4LifeBookCode,
  sectionForStyle,
  type Reach4LifeContentType,
  type Reach4LifeSection,
} from "./note-rules"

export interface Reach4LifeNote {
  /**
   * The cell's unit: one sentence of a line, one whole line, or the whole
   * paragraph when it holds neither a line break nor a sentence boundary.
   */
  readonly unit: IdmlTranslationUnit
  /**
   * Set when the unit is one sentence of a larger line, which the exporter has
   * to rebuild before handing the line to the engine. Absent when the unit is
   * the whole thing its locator addresses.
   */
  readonly rejoin?: Reach4LifeNoteRejoin
  readonly section: Reach4LifeSection
  /** Book this cell introduces, for the per-book introductions. */
  readonly bookCode?: string
  readonly contentType: Reach4LifeContentType
}

export interface Reach4LifeNoteRejoin {
  readonly index: number
  readonly count: number
  readonly ranges: readonly IdmlSliceRange[]
}

export interface Reach4LifeSelection {
  readonly notes: readonly Reach4LifeNote[]
  /** Units skipped because they are the published Bible text. */
  readonly scriptureUnitCount: number
  /** Units skipped because they are page furniture or hold no visible text. */
  readonly otherUnitCount: number
}

export interface SelectReach4LifeNotesOptions {
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

interface PlacedUnit {
  readonly unit: IdmlTranslationUnit
  readonly section: Reach4LifeSection
  readonly contentType: Reach4LifeContentType
  bookCode: string
}

/**
 * Which section — and, in the book introductions, which book — each content
 * paragraph belongs to, in document order.
 *
 * A paragraph's section comes from its own style, so only the book needs
 * tracking. Reach4Life sets a book introduction as a run of paragraphs opened
 * by a title ("Matthew"), preceded by the strapline that sits above the title
 * on the page ("Stories about Jesus"). The strapline names the collection, not
 * the book, so nothing before the title says which book is coming — the title
 * claims its straplines backwards once it is read. Only straplines: the
 * paragraph before them is the previous book's last line, and claiming that
 * would move a finished introduction under the next book.
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

  for (const unit of units) {
    const paragraphStyle = unit.paragraphStyleId ?? ""
    const kind = classifyReach4LifeUnit(paragraphStyle)

    if (kind === "scripture") {
      scriptureUnitCount += 1
      continue
    }
    if (kind === "furniture" || !hasVisibleText(unit)) {
      otherUnitCount += 1
      continue
    }

    const section = sectionForStyle(paragraphStyle)
    const contentType = contentTypeForSection(section.id)

    // Read the title before placing it, so it belongs to the book it opens
    // rather than to the one before it.
    if (isReach4LifeBookTitleStyle(paragraphStyle)) {
      const bookCode = parseReach4LifeBookCode(unit.sourceText)
      if (bookCode) {
        currentBook = bookCode
        for (let index = placed.length - 1; index >= 0; index -= 1) {
          const earlier = placed[index]!
          if (!isReach4LifeBookStraplineStyle(earlier.unit.paragraphStyleId ?? "")) break
          earlier.bookCode = bookCode
        }
      }
    }

    placed.push({
      unit,
      section,
      contentType,
      // Only the introductions are per-book; a lesson that quotes six books
      // belongs to none of them.
      bookCode: isBookIntroSection(section.id) ? currentBook : "",
    })
  }

  return { placed, scriptureUnitCount, otherUnitCount }
}

export function selectReach4LifeNotes(
  units: readonly IdmlTranslationUnit[],
  options?: SelectReach4LifeNotesOptions,
): Reach4LifeSelection {
  const splitSentences = options?.splitSentences !== false
  const { placed, scriptureUnitCount, otherUnitCount } = placeContentUnits(units)
  const notes: Reach4LifeNote[] = []

  for (const entry of placed) {
    const common = {
      section: entry.section,
      ...(entry.bookCode ? { bookCode: entry.bookCode } : {}),
      contentType: entry.contentType,
    }

    // One cell per line: a contents block or a list of journey steps set as a
    // single paragraph would otherwise arrive as one cell holding every entry.
    // Lines that are only structural glue own no cell, and their slots keep
    // their source text on export.
    for (const line of partitionIdmlUnitAtLineBreaks(entry.unit)) {
      if (!hasVisibleText(line)) continue
      if (!splitSentences) {
        notes.push({ unit: line, ...common })
        continue
      }

      // One cell per sentence. Slices are kept whole and in order, however
      // little text a slice holds, because their ranges have to tile the line
      // for the exporter to rebuild it.
      const slices = sliceIdmlUnit(line, reach4LifeSentenceCutPoints(slotText(line)))
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
