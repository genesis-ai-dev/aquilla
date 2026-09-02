import type { IdmlProgress } from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import {
  selectTreasureHuntNotes,
  type TreasureHuntSelection,
} from "@/lib/partner-integrations/biblica/treasure-hunt/notes"
import { IDML_REJOIN_METADATA_KEY, idmlRejoinMetadata } from "@/lib/idml/rejoin"
import { idmlUnitToTranslatableString, type IdmlParseExecutor } from "@/lib/parsers/idml"
import type { TranslatableString } from "@/lib/parsers/types"

export interface TreasureHuntParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
  /**
   * When true (default), cut long note lines into one cell per sentence.
   * When false, each line stays a single cell (lists still split per line).
   */
  splitSentences?: boolean
}

export interface TreasureHuntParseResult {
  strings: TranslatableString[]
  /** Book codes encountered, in first-seen order. */
  bookCodes: string[]
  skipped: Pick<TreasureHuntSelection, "scriptureUnitCount" | "otherUnitCount">
}

/**
 * Parse a Treasure Hunt Bible IDML package into note cells.
 *
 * The package is parsed with the shared `generic` profile so nothing is lost or
 * reinterpreted, then filtered to everything set around the Bible text: the
 * fact and hunt blocks, the per-book introductions, and the front matter. The
 * NIrV text itself is deliberately left out — it is set from the publisher's
 * scripture files, not translated here.
 */
export async function extractTreasureHuntStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  options?: TreasureHuntParseOptions,
): Promise<TreasureHuntParseResult> {
  const result = await parse(buffer, "generic", {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  })
  const selection = selectTreasureHuntNotes(result.units, {
    ...(options?.splitSentences !== undefined
      ? { splitSentences: options.splitSentences }
      : {}),
  })

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
        // Deliberately the same `biblica` bucket the study-notes importer fills:
        // milestone planning, the navigator and the export path all read this
        // shape, and a Treasure Hunt cell wants the same treatment.
        biblica: {
          version: 1,
          contentType: note.contentType,
          edition: "treasure-hunt",
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
      scriptureUnitCount: selection.scriptureUnitCount,
      otherUnitCount: selection.otherUnitCount,
    },
  }
}
