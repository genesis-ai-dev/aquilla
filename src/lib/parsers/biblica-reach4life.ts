import type { IdmlProgress } from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import {
  selectReach4LifeNotes,
  type Reach4LifeSelection,
} from "@/lib/biblica/reach4life/notes"
import { getBookName } from "@/lib/file-labeling/bible-book-names"
import { IDML_REJOIN_METADATA_KEY, idmlRejoinMetadata } from "@/lib/idml/rejoin"
import type { ImportMilestone } from "../../../shared/import-contract"
import { idmlUnitToTranslatableString, type IdmlParseExecutor } from "./idml"
import type { TranslatableString } from "./types"

export interface Reach4LifeParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
  /**
   * When true (default), cut long paragraphs into one cell per sentence.
   * When false, each line stays a single cell (lists still split per line).
   */
  splitSentences?: boolean
}

export interface Reach4LifeParseResult {
  strings: TranslatableString[]
  /** Book codes encountered, in first-seen order. */
  bookCodes: string[]
  skipped: Pick<Reach4LifeSelection, "scriptureUnitCount" | "otherUnitCount">
}

/**
 * Parse a Reach4Life IDML package into workbook cells.
 *
 * The package is parsed with the shared `generic` profile so nothing is lost or
 * reinterpreted, then filtered to everything set around the Bible text: the
 * lessons and journeys, the hot topics, the per-book introductions, and the
 * front and back matter. The continuous NIrV text is deliberately left out — it
 * is set from the publisher's scripture files, not translated here — while the
 * verses quoted inside a lesson stay, because they are part of that lesson.
 *
 * Unlike the other Biblica editions, Reach4Life is not organized by chapter, so
 * each cell carries its section as an explicit navigation milestone: a book
 * introduction groups under its book, and everything else under the workbook
 * feature it belongs to ("Who am I?", "The 4 journeys", "Hot topics").
 */
export async function extractReach4LifeStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  options?: Reach4LifeParseOptions,
): Promise<Reach4LifeParseResult> {
  const result = await parse(buffer, "generic", {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  })
  const selection = selectReach4LifeNotes(result.units, {
    ...(options?.splitSentences !== undefined
      ? { splitSentences: options.splitSentences }
      : {}),
  })

  const bookCodes: string[] = []
  // Milestone badges number the workbook's sections in the order they appear,
  // which is deterministic for one package and so stable across re-imports.
  const sectionOrdinals = new Map<string, number>()

  const strings = selection.notes.map((note) => {
    if (note.bookCode && !bookCodes.includes(note.bookCode)) bookCodes.push(note.bookCode)
    const value = idmlUnitToTranslatableString(note.unit, result.styleCatalog)
    const milestone = milestoneFor(note.bookCode, note.section.id, note.section.label, sectionOrdinals)
    return {
      ...value,
      section: milestone.label,
      milestone,
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
        // Deliberately the same `biblica` bucket the other Biblica importers
        // fill: the navigator and the export path both read this shape, and a
        // Reach4Life cell wants the same treatment.
        biblica: {
          version: 1,
          contentType: note.contentType,
          edition: "reach4life",
          sectionId: note.section.id,
          sectionLabel: note.section.label,
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

/**
 * A book introduction navigates by its book, so it reads like the rest of the
 * app's scripture navigation ("Matthew introduction", badge "MAT"). Every other
 * section navigates by its own name, badged with its position in the workbook.
 */
function milestoneFor(
  bookCode: string | undefined,
  sectionId: string,
  sectionLabel: string,
  ordinals: Map<string, number>,
): ImportMilestone {
  if (bookCode) {
    const bookName = getBookName(bookCode) ?? bookCode
    return {
      key: `reach4life:book:${bookCode}`,
      kind: "preface",
      label: `${bookName} introduction`,
      shortLabel: bookCode,
    }
  }
  const ordinal = ordinals.get(sectionId) ?? ordinals.size + 1
  ordinals.set(sectionId, ordinal)
  return {
    key: `reach4life:section:${sectionId}`,
    kind: "section",
    label: sectionLabel,
    shortLabel: String(ordinal),
  }
}
