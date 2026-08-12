/**
 * Select the translatable text from a Biblica front/back-matter IDML volume.
 *
 * A study Bible's front and back matter — title pages, table of contents, "how
 * to use", the Bible Dictionary, timelines — ships as its own IDML packages with
 * no scripture in them, so no chapter or verse is ever marked. Their text lives
 * in layout paragraph styles (`title:mt1`, `toc:*`, `text:m`, box text) rather
 * than the `intro:*` note styles, so the notes-only selection finds nothing in
 * them and the import refuses the file outright.
 *
 * Here every text-bearing paragraph is a cell instead. The exceptions are
 * paragraphs InDesign regenerates rather than an author writing them: running
 * heads (`meta:rh`) and the `meta:bk` book-code marker. Sections come from the
 * volume's own headings (`intro:imt2`, `head:ms1`), and the heading stays a
 * translatable cell inside the section it opens.
 *
 * Unlike study notes, "source serif" apostrophe runs stay visible: in prose they
 * are ordinary possessives and contractions ("Jacobʼs", "didnʼt"), not the
 * structural glue they are around a note's markers.
 *
 * Like the notes selection this is a presentation filter over parsed units — it
 * never reinterprets the package. Every emitted cell is an engine projection or
 * slice of its paragraph, so protected-HTML editing and strict export keep
 * working on the original bytes.
 */

import {
  partitionIdmlUnitAtLineBreaks,
  sliceIdmlUnit,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import { biblicaSentenceCutPoints } from "./sentence-cuts"
import {
  isBiblicaBookMarkerStyle,
  isBiblicaFrontMatterHeadingStyle,
  isBiblicaRunningHeadStyle,
  isChapterVerseMarkerCharacterStyle,
  isStructuralOnlyContent,
} from "./note-rules"
import type { BiblicaNoteRejoin } from "./study-notes"

/** Section for the text a volume opens with, ahead of its first heading. */
export const BIBLICA_FRONT_MATTER_OPENING_SECTION = "Opening"

export interface BiblicaFrontMatterCell {
  /** The cell's unit: one line of a paragraph, or one sentence of that line. */
  readonly unit: IdmlTranslationUnit
  /** Set when the unit is one slice of a larger line (see `BiblicaStudyNote`). */
  readonly rejoin?: BiblicaNoteRejoin
  /** Heading that opened the section this cell sits in. */
  readonly sectionLabel: string
}

export interface BiblicaFrontMatterSelection {
  readonly cells: readonly BiblicaFrontMatterCell[]
  /** Paragraphs that own no cell: running heads, book markers, structural glue. */
  readonly otherUnitCount: number
}

export interface SelectBiblicaFrontMatterOptions {
  /**
   * When true, cut each line at sentence boundaries so a long prose block
   * arrives as one cell per sentence. When false, each line is one cell.
   */
  readonly splitSentences?: boolean
}

/**
 * True when the package marks no chapter or verse anywhere, which is what
 * separates a front/back-matter volume from a study-notes volume. Notes are
 * delimited by the verse runs they annotate, so a notes package always marks
 * them; front and back matter never does.
 */
export function isBiblicaFrontMatterVolume(units: readonly IdmlTranslationUnit[]): boolean {
  return !units.some((unit) => unit.slots.some(
    (slot) => isChapterVerseMarkerCharacterStyle(slot.characterStyleId),
  ))
}

/** The coordinate space sentence cuts are expressed in: slot text, nothing else. */
function slotText(unit: IdmlTranslationUnit): string {
  return unit.slots.map((slot) => slot.text).join("")
}

/**
 * A heading's own text, as the section label. Collapsed to single spaces because
 * InDesign may break a heading across `<Content>` runs and lines.
 */
function sectionLabelFrom(unit: IdmlTranslationUnit): string | undefined {
  const label = unit.sourceText.replace(/\s+/g, " ").trim()
  return label.length > 0 ? label : undefined
}

/**
 * Paragraphs InDesign generates from the layout rather than an author writing
 * them. They carry no translatable text and would surface as repeated
 * page-furniture cells.
 */
function isGeneratedFurniture(paragraphStyle: string): boolean {
  return isBiblicaRunningHeadStyle(paragraphStyle) || isBiblicaBookMarkerStyle(paragraphStyle)
}

export function selectBiblicaFrontMatter(
  units: readonly IdmlTranslationUnit[],
  options?: SelectBiblicaFrontMatterOptions,
): BiblicaFrontMatterSelection {
  const splitSentences = options?.splitSentences === true
  const cells: BiblicaFrontMatterCell[] = []
  let otherUnitCount = 0
  let sectionLabel = BIBLICA_FRONT_MATTER_OPENING_SECTION

  for (const unit of units) {
    const paragraphStyle = unit.paragraphStyleId ?? ""

    if (isGeneratedFurniture(paragraphStyle)) {
      otherUnitCount += 1
      continue
    }

    // A heading opens its section and is then imported like any other paragraph,
    // so the translator can edit the heading itself.
    if (isBiblicaFrontMatterHeadingStyle(paragraphStyle)) {
      sectionLabel = sectionLabelFrom(unit) ?? sectionLabel
    }

    const before = cells.length

    // One cell per line: Biblica sets a table of contents, an index, or a
    // dictionary entry list as a single paragraph with `<Br/>` between items.
    // Lines that are only structural glue own no cell, and their slots keep
    // their source text on export.
    for (const line of partitionIdmlUnitAtLineBreaks(unit)) {
      if (isStructuralOnlyContent(line.slots.map((slot) => slot.text))) continue

      if (!splitSentences) {
        cells.push({ unit: line, sectionLabel })
        continue
      }

      // Slices are kept whole and in order, however little text a slice holds,
      // because their ranges have to tile the line for the exporter to rebuild it.
      const slices = sliceIdmlUnit(line, biblicaSentenceCutPoints(slotText(line)))
      for (const [index, slice] of slices.entries()) {
        cells.push({
          unit: slice.unit,
          ...(slices.length > 1
            ? { rejoin: { index, count: slices.length, ranges: slice.ranges } }
            : {}),
          sectionLabel,
        })
      }
    }

    if (cells.length === before) otherUnitCount += 1
  }

  return { cells, otherUnitCount }
}
