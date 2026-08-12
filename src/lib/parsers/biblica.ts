import type { IdmlProgress, IdmlTranslationUnit } from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import {
  selectBiblicaStudyNotes,
  type BiblicaNoteRejoin,
  type BiblicaStudyNoteSelection,
} from "@/lib/biblica/study-notes"
import {
  isBiblicaFrontMatterVolume,
  selectBiblicaFrontMatter,
} from "@/lib/biblica/front-matter"
import { IDML_REJOIN_METADATA_KEY, idmlRejoinMetadata } from "@/lib/idml/rejoin"
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

/**
 * Which shape the package was read as: a study-notes volume (the `intro:*` notes
 * around marked scripture) or a front/back-matter volume (a package with no
 * chapter or verse marked anywhere, imported as all of its text).
 */
export type BiblicaVolumeContentType = "notes" | "front-matter"

export interface BiblicaStudyNotesParseResult {
  strings: TranslatableString[]
  /** Book codes encountered, in first-seen order. Front matter names no book. */
  bookCodes: string[]
  contentType: BiblicaVolumeContentType
  skipped: Pick<BiblicaStudyNoteSelection, "verseUnitCount" | "otherUnitCount">
}

/**
 * Parse a Biblica study-Bible IDML package into cells.
 *
 * The package is parsed with the shared `generic` profile so nothing is lost or
 * reinterpreted, then filtered down to what a translator owns. Which filter runs
 * depends on the volume: a notes volume keeps only its note paragraphs, because
 * the Bible text is set from the publisher's scripture files rather than
 * translated here, and verse runs drive each note's book and chapter-range
 * label. A front/back-matter volume marks no verses at all, so every
 * text-bearing paragraph is imported and the volume's own headings become its
 * sections.
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
  const sentenceOption = options?.splitSentences !== undefined
    ? { splitSentences: options.splitSentences }
    : {}

  if (isBiblicaFrontMatterVolume(result.units)) {
    const selection = selectBiblicaFrontMatter(result.units, sentenceOption)
    return {
      strings: selection.cells.map((cell) => biblicaTranslatableString(cell.unit, cell.rejoin, {
        section: cell.sectionLabel,
        biblica: { contentType: "front-matter", sectionLabel: cell.sectionLabel },
      })),
      bookCodes: [],
      contentType: "front-matter",
      skipped: { verseUnitCount: 0, otherUnitCount: selection.otherUnitCount },
    }
  }

  const selection = selectBiblicaStudyNotes(result.units, sentenceOption)

  const bookCodes: string[] = []
  const strings = selection.notes.map((note) => {
    if (note.bookCode && !bookCodes.includes(note.bookCode)) bookCodes.push(note.bookCode)
    return biblicaTranslatableString(note.unit, note.rejoin, {
      section: note.bookCode ? `${note.bookCode} ${note.chapterLabel}` : note.chapterLabel,
      ...(note.bookCode ? { globalReferences: [note.bookCode] } : {}),
      biblica: {
        contentType: "notes",
        chapterLabel: note.chapterLabel,
        ...(note.bookCode ? { bookCode: note.bookCode } : {}),
      },
    })
  })

  return {
    strings,
    bookCodes,
    contentType: "notes",
    skipped: {
      verseUnitCount: selection.verseUnitCount,
      otherUnitCount: selection.otherUnitCount,
    },
  }
}

interface BiblicaCellShape {
  readonly section: string
  readonly globalReferences?: string[]
  /** Provenance for the editor's section navigation; merged with the unit's style. */
  readonly biblica: Record<string, unknown> & { readonly contentType: BiblicaVolumeContentType }
}

/**
 * One selected unit as one Aquilla cell. Both volume shapes go through the same
 * IDML mapping, so every cell carries the same protected anchors, locator, and
 * v2 metadata whichever filter chose it.
 */
function biblicaTranslatableString(
  unit: IdmlTranslationUnit,
  rejoin: BiblicaNoteRejoin | undefined,
  shape: BiblicaCellShape,
): TranslatableString {
  const value = idmlUnitToTranslatableString(unit)
  return {
    ...value,
    section: shape.section,
    ...(shape.globalReferences ? { globalReferences: shape.globalReferences } : {}),
    metadata: {
      ...value.metadata,
      // A sliced cell shares its line's locator, so this bucket is the only
      // record of which part of that line it owns. Without it the exporter
      // cannot rebuild the line and refuses to export.
      ...(rejoin
        ? {
            [IDML_REJOIN_METADATA_KEY]: idmlRejoinMetadata(
              rejoin.index,
              rejoin.count,
              rejoin.ranges,
            ),
          }
        : {}),
      biblica: {
        version: 1,
        ...shape.biblica,
        ...(unit.paragraphStyleId ? { paragraphStyle: unit.paragraphStyleId } : {}),
      },
    },
  }
}
