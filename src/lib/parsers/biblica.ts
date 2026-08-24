import type { IdmlProgress } from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import {
  isBiblicaFrontBackMatterPackage,
  selectBiblicaStudyNotes,
  type BiblicaNoteSection,
  type BiblicaStudyNoteSelection,
} from "@/lib/biblica/study-notes"
import { IDML_REJOIN_METADATA_KEY, idmlRejoinMetadata } from "@/lib/idml/rejoin"
import type { ImportMilestone } from "../../../shared/import-contract"
import { idmlUnitToTranslatableString, type IdmlParseExecutor } from "./idml"
import type { TranslatableString } from "./types"

export interface BiblicaStudyNotesParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
  /**
   * When true, cut long note lines into one cell per sentence.
   * When false, each line stays a single cell (lists still split per line).
   */
  splitSentences?: boolean
}

export interface BiblicaStudyNotesParseResult {
  strings: TranslatableString[]
  /** Book codes encountered, in first-seen order. */
  bookCodes: string[]
  /**
   * True when the package was read as a front/back matter volume: contents,
   * "how to use", the Bible Dictionary, the timelines, the maps, the cover.
   * Those hold no scripture, so an empty result is a legitimate outcome
   * (the maps volume is artwork) rather than the wrong edition.
   */
  frontBackMatter: boolean
  skipped: Pick<BiblicaStudyNoteSelection, "verseUnitCount" | "otherUnitCount">
}

/**
 * Parse a Biblica study-Bible IDML package into study-note cells.
 *
 * The package is parsed with the shared `generic` profile so nothing is lost or
 * reinterpreted, then filtered to the note paragraphs and the `head:*` headings
 * the layout sets around the verses. Scripture is deliberately left out: it is
 * set from the publisher's Bible files, not translated here. Verse runs still
 * drive each note's book and chapter-range label.
 *
 * The study Bible's front and back matter ships as separate volumes with no
 * scripture in them at all, which is how they are recognized. They set their
 * text in layout styles rather than in `intro:*`, so there every text-bearing
 * paragraph becomes a cell and the headings — rather than chapters — group them.
 */
export async function extractBiblicaStudyNoteStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  options?: BiblicaStudyNotesParseOptions,
): Promise<BiblicaStudyNotesParseResult> {
  const result = await parse(buffer, "generic", {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  })
  const frontBackMatter = isBiblicaFrontBackMatterPackage(result.units)
  const selection = selectBiblicaStudyNotes(result.units, {
    ...(options?.splitSentences !== undefined
      ? { splitSentences: options.splitSentences }
      : {}),
    frontBackMatter,
  })

  const bookCodes: string[] = []
  // Section badges number the headings in the order they appear, which is
  // deterministic for one package and so stable across re-imports.
  const sectionOrdinals = new Map<string, number>()

  const strings = selection.notes.map((note) => {
    if (note.bookCode && !bookCodes.includes(note.bookCode)) bookCodes.push(note.bookCode)
    const value = idmlUnitToTranslatableString(note.unit)
    const milestone = note.section
      ? sectionMilestone(note.section, sectionOrdinals)
      : undefined
    const chapterSection = note.bookCode
      ? `${note.bookCode} ${note.chapterLabel}`
      : note.chapterLabel
    return {
      ...value,
      ...(milestone ? { milestone, section: milestone.label } : {}),
      ...(!milestone && chapterSection ? { section: chapterSection } : {}),
      ...(note.bookCode ? { globalReferences: [note.bookCode] } : {}),
      metadata: {
        ...value.metadata,
        // A sentence cell shares its line's locator, so this bucket is the only
        // record of which part of that line it owns. Without it the exporter
        // cannot rebuild the line and refuses to export.
        ...(note.rejoin
          ? {
              [IDML_REJOIN_METADATA_KEY]: idmlRejoinMetadata(
                note.rejoin.index,
                note.rejoin.count,
                note.rejoin.ranges,
              ),
            }
          : {}),
        biblica: {
          version: 1,
          contentType: frontBackMatter ? "front-back-matter" : "notes",
          ...(note.chapterLabel ? { chapterLabel: note.chapterLabel } : {}),
          ...(note.section
            ? { sectionId: note.section.id, sectionLabel: note.section.label }
            : {}),
          ...(note.bookCode ? { bookCode: note.bookCode } : {}),
          ...(note.unit.paragraphStyleId
            ? { paragraphStyle: note.unit.paragraphStyleId }
            : {}),
        },
      },
    }
  })

  return {
    strings,
    bookCodes,
    frontBackMatter,
    skipped: {
      verseUnitCount: selection.verseUnitCount,
      otherUnitCount: selection.otherUnitCount,
    },
  }
}

/**
 * A heading-titled section navigates by its own name — "Israelʼs covenant
 * history", or a Bible Dictionary letter — badged with its position in the
 * volume, because the heading itself is too long to sit in a badge.
 */
function sectionMilestone(
  section: BiblicaNoteSection,
  ordinals: Map<string, number>,
): ImportMilestone {
  const ordinal = ordinals.get(section.id) ?? ordinals.size + 1
  ordinals.set(section.id, ordinal)
  return {
    key: `biblica:section:${section.id}`,
    kind: "section",
    label: section.label,
    shortLabel: section.label.length <= 2 ? section.label : String(ordinal),
  }
}
