// DOCX bytes → the revision units the browser importer would send for them.
//
// The Drive sync must produce the SAME unit keys, stamp and metadata as an
// upload of the same file in the Import dialog, or a file imported by hand and
// then linked would realign every paragraph. So this runs the same three steps
// as `src/lib/import.ts` (extractDocxStrings → normalizeTranslatableStrings →
// buildBulkCellsWithSpeakers) and `revisionUnitsFromCells`, minus the parts a
// DOCX never has (targets, timings, speakers, media). The parity is pinned by
// `src/lib/sync/drive-units-parity.test.ts`.

import { extractDocxStrings } from '../../../src/lib/parsers/docx'
import type { CellUnit } from '../../../src/lib/parsers/core-types'
import {
  aquillaImportMetadata,
  normalizeTranslatableStrings,
  summarizeNormalizedImport,
  type NormalizedImportSummary,
} from '../../../src/lib/import/normalized-manifest'
import type { RevisionUnitInput } from '../../../db/shared/file-revision'

/** Locator kinds whose unit key encodes a position — same set as
 *  `src/lib/sync/revision-import.ts`. */
const POSITIONAL_LOCATORS: ReadonlySet<string> = new Set(['package-block', 'sequence', 'cue', 'idml'])

export interface DocxRevision {
  /** `<profileId>@<profileVersion>` — the file's parserVersion and the stamp. */
  stamp: string
  units: RevisionUnitInput[]
  importManifest: NormalizedImportSummary
}

export async function docxRevisionUnits(
  bytes: Uint8Array,
  options: { fileName: string; cellUnit?: CellUnit },
): Promise<DocxRevision> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const strings = await extractDocxStrings(buffer, options.cellUnit ? { cellUnit: options.cellUnit } : undefined)
  const normalized = normalizeTranslatableStrings(strings, {
    fileName: options.fileName,
    fileType: 'docx',
    profileId: 'builtin:docx',
    profileVersion: '1',
  })
  const seen = new Map<string, number>()
  const units = normalized.units.map((unit, index): RevisionUnitInput => {
    const str = strings[index]
    const metadata: Record<string, unknown> = {
      ...(str.metadata ?? {}),
      aquillaImport: aquillaImportMetadata(normalized, unit),
      ...(str.paragraphStart ? { paragraphStart: true } : {}),
      ...(str.paragraphMarker ? { paragraphMarker: str.paragraphMarker } : {}),
    }
    const n = (seen.get(unit.unitKey) ?? 0) + 1
    seen.set(unit.unitKey, n)
    const positional = !unit.canonicalRef && POSITIONAL_LOCATORS.has(unit.sourceLocator.kind)
    return {
      unitKey: n === 1 ? unit.unitKey : `${unit.unitKey}#${n}`,
      positional,
      text: unit.sourceText,
      ...(unit.sourceHtml ? { html: unit.sourceHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(unit.canonicalRef ? { canonicalRef: unit.canonicalRef } : {}),
      sequenceIndex: unit.physicalOrder,
      metadata,
    }
  })
  return {
    stamp: `${normalized.profileId}@${normalized.profileVersion}`,
    units,
    importManifest: summarizeNormalizedImport(normalized),
  }
}
