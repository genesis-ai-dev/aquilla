import type { IdmlProgress } from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import {
  selectEblNotes,
  type EblDivisionKind,
  type EblSelection,
} from "@/lib/biblica/ebl/notes"
import { IDML_REJOIN_METADATA_KEY, idmlRejoinMetadata } from "@/lib/idml/rejoin"
import type { ImportMilestone } from "../../../shared/import-contract"
import { idmlUnitToTranslatableString, type IdmlParseExecutor } from "./idml"
import type { TranslatableString } from "./types"

export interface EblParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
  /**
   * When true (default), cut long paragraphs into one cell per sentence.
   * When false, each line stays a single cell (lists still split per line).
   */
  splitSentences?: boolean
}

export interface EblParseResult {
  strings: TranslatableString[]
  skipped: Pick<EblSelection, "otherUnitCount">
}

/**
 * How each kind of division is recorded on the cell. The navigator only reads
 * the milestone; this is provenance, for anything later that wants to tell a
 * lesson from the front matter without re-reading paragraph styles.
 */
const CONTENT_TYPES: Readonly<Record<EblDivisionKind, string>> = {
  section: "section",
  topic: "topic-intro",
  lesson: "lesson",
  boxes: "boxes",
}

/**
 * Parse an Equipping Biblical Leaders IDML package into guide cells.
 *
 * The package is parsed with the shared `generic` profile so nothing is lost or
 * reinterpreted, then filtered to everything that carries text. Unlike the
 * other Biblica editions nothing is skipped for being scripture: an EBL guide
 * is written material throughout, and the verses it quotes are part of the
 * teaching around them.
 *
 * A guide is far too long to navigate flat, so each cell carries its division
 * as an explicit navigation milestone, read out of the outline the template
 * numbers itself with — the front-matter sections, then a milestone per topic
 * opener and per lesson ("Topic 1.2: How the Bible was inspired", "Lesson 3:
 * An act of faith"). See `@/lib/biblica/ebl/notes`.
 */
export async function extractEblStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  options?: EblParseOptions,
): Promise<EblParseResult> {
  const result = await parse(buffer, "generic", {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  })
  const selection = selectEblNotes(result.units, {
    ...(options?.splitSentences !== undefined
      ? { splitSentences: options.splitSentences }
      : {}),
  })

  const strings = selection.notes.map((note) => {
    const value = idmlUnitToTranslatableString(note.unit, result.styleCatalog)
    const milestone: ImportMilestone | undefined = note.division
      ? {
          key: note.division.key,
          // The guide has no chapters, and every division — front matter, topic
          // opener, lesson — reads as a section of it.
          kind: "section",
          label: note.division.label,
          shortLabel: note.division.shortLabel,
        }
      : undefined
    return {
      ...value,
      ...(milestone ? { section: milestone.label, milestone } : {}),
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
        // fill: the navigator and the export path both read this shape.
        biblica: {
          version: 1,
          edition: "ebl",
          ...(note.division
            ? {
                contentType: CONTENT_TYPES[note.division.kind],
                sectionId: note.division.key,
                sectionLabel: note.division.label,
              }
            : {}),
          ...(note.unit.paragraphStyleId
            ? { paragraphStyle: note.unit.paragraphStyleId }
            : {}),
        },
      },
    }
  })

  return { strings, skipped: { otherUnitCount: selection.otherUnitCount } }
}
