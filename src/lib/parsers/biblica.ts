import type { IdmlProgress } from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import {
  selectBiblicaStudyNotes,
  type BiblicaStudyNoteSelection,
} from "@/lib/biblica/study-notes"
import { IDML_REJOIN_METADATA_KEY, idmlRejoinMetadata } from "@/lib/idml/rejoin"
import { idmlUnitToTranslatableString, type IdmlParseExecutor } from "./idml"
import type { TranslatableString } from "./types"

export interface BiblicaStudyNotesParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
}

export interface BiblicaStudyNotesParseResult {
  strings: TranslatableString[]
  /** Book codes encountered, in first-seen order. */
  bookCodes: string[]
  skipped: Pick<BiblicaStudyNoteSelection, "verseUnitCount" | "otherUnitCount">
}

/**
 * Parse a Biblica study-Bible IDML package into study-note cells.
 *
 * The package is parsed with the shared `generic` profile so nothing is lost or
 * reinterpreted, then filtered to the note paragraphs. Scripture is deliberately
 * left out: it is set from the publisher's Bible files, not translated here.
 * Verse runs still drive each note's book and chapter-range label.
 */
export async function extractBiblicaStudyNoteStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  options?: BiblicaStudyNotesParseOptions,
): Promise<BiblicaStudyNotesParseResult> {
  const result = await parse(buffer, "generic", options)
  const selection = selectBiblicaStudyNotes(result.units)

  const bookCodes: string[] = []
  const strings = selection.notes.map((note) => {
    if (note.bookCode && !bookCodes.includes(note.bookCode)) bookCodes.push(note.bookCode)
    const value = idmlUnitToTranslatableString(note.unit)
    return {
      ...value,
      section: note.bookCode ? `${note.bookCode} ${note.chapterLabel}` : note.chapterLabel,
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
          contentType: "notes",
          chapterLabel: note.chapterLabel,
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
    skipped: {
      verseUnitCount: selection.verseUnitCount,
      otherUnitCount: selection.otherUnitCount,
    },
  }
}
