// SDBH lexicon import orchestration: MARBLE JSON editions → per-letter source
// files (+ the domain-label file), optionally pre-filling the target column
// from a localized edition. Mirrors the paired-import flow: bulkUploadSource
// seeds the source cells, then bulkUploadTargetCommits chains one
// target.cell.commit per translated cell onto the source event ids.
import { v7 as uuidv7 } from "uuid"
import type { FileReference } from "./parsers/types"
import {
  extractSdbhLocalized,
  parseSdbhLexicon,
  type SdbhEntry,
  type SdbhParsedFile,
} from "./parsers/sdbh"
import { buildBulkCells, type ImportContext } from "./import"
import {
  bulkUploadSource,
  bulkUploadTargetCommits,
  type TargetCommit,
} from "./sync/bulk-import"

export type SdbhImportPhase = "parse" | "source" | "target"

export interface SdbhImportProgress {
  phase: SdbhImportPhase
  /** Current file (1-based) / total files, during source + target phases. */
  fileIndex?: number
  fileCount?: number
  cellsEnqueued?: number
  cellsTotal?: number
}

export interface SdbhImportSummary {
  refs: FileReference[]
  entryCount: number
  senseCount: number
  sourceCellCount: number
  targetCellCount: number
  /** Language code found in the localized edition's senses (e.g. "es"). */
  targetLanguageCode: string | null
}

function parseEntries(jsonText: string, label: string): SdbhEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error(`${label} is not valid JSON — expected a MARBLE SDBH-<lang>.JSON edition.`)
  }
  if (!Array.isArray(parsed) || (parsed.length > 0 && typeof (parsed[0] as SdbhEntry).MainId !== "string")) {
    throw new Error(`${label} doesn't look like an SDBH edition (expected an array of lexicon entries with MainId/Lemma).`)
  }
  return parsed as SdbhEntry[]
}

/**
 * Import the SDBH lexicon. `masterJson` (usually the English edition) supplies
 * the source text and the file/cell structure; `localizedJson` (optional)
 * pre-fills the target column for every sense the localization has translated.
 * Both must be MARBLE `SDBH-<lang>.JSON` editions — the shared LEXIDs are the
 * alignment key, so structure divergence is impossible by construction.
 */
export async function importSdbh(
  masterJson: string,
  localizedJson: string | null,
  ctx: ImportContext,
  onProgress?: (p: SdbhImportProgress) => void,
): Promise<SdbhImportSummary> {
  onProgress?.({ phase: "parse" })
  const masterEntries = parseEntries(masterJson, "The master edition file")
  const parsed = parseSdbhLexicon(masterEntries)

  const localized = localizedJson
    ? extractSdbhLocalized(parseEntries(localizedJson, "The localized edition file"))
    : null

  const files: SdbhParsedFile[] = [...parsed.files, parsed.domainFile]
  const refs: FileReference[] = []
  let sourceCellCount = 0
  let targetCellCount = 0

  for (let i = 0; i < files.length; i++) {
    const parsedFile = files[i]
    const fileId = uuidv7()
    const cells = buildBulkCells(parsedFile.strings)

    onProgress?.({ phase: "source", fileIndex: i + 1, fileCount: files.length, cellsEnqueued: 0, cellsTotal: cells.length })
    await bulkUploadSource({
      projectId: ctx.projectId,
      fileId,
      file: {
        id: uuidv7(),
        name: parsedFile.name,
        fileType: "sdbh",
        role: "source",
        kind: "sdbh",
        importFormat: "sdbh",
        parserVersion: "sdbh-import-v1",
        sourceLanguage: ctx.sourceLanguage,
        targetLanguage: ctx.targetLanguage,
        orderedBy: "sequence",
      },
      cells,
      getToken: ctx.getToken,
      signal: ctx.signal,
      onProgress: (uploaded, total) =>
        onProgress?.({ phase: "source", fileIndex: i + 1, fileCount: files.length, cellsEnqueued: uploaded, cellsTotal: total }),
    })
    sourceCellCount += cells.length

    if (localized) {
      // Source event ids come from the SAME buildBulkCells call that minted the
      // uploaded cells, so the AD-2 parentId chain is correct by construction.
      const commits: TargetCommit[] = []
      for (const cell of cells) {
        const value = localized.byCellId.get(cell.cellId)
        if (value) {
          commits.push({ id: uuidv7(), cellId: cell.cellId, parentId: cell.id, value })
        }
      }
      if (commits.length > 0) {
        onProgress?.({ phase: "target", fileIndex: i + 1, fileCount: files.length, cellsEnqueued: 0, cellsTotal: commits.length })
        await bulkUploadTargetCommits({
          projectId: ctx.projectId,
          fileId,
          author: ctx.author,
          commits,
          getToken: ctx.getToken,
          signal: ctx.signal,
          onProgress: (uploaded, total) =>
            onProgress?.({ phase: "target", fileIndex: i + 1, fileCount: files.length, cellsEnqueued: uploaded, cellsTotal: total }),
        })
        targetCellCount += commits.length
      }
    }

    refs.push({
      id: fileId,
      name: parsedFile.name,
      type: "sdbh",
      createdAt: new Date().toISOString(),
      cellCount: cells.length,
      orderedBy: "sequence",
    })
  }

  return {
    refs,
    entryCount: parsed.entryCount,
    senseCount: parsed.senseCount,
    sourceCellCount,
    targetCellCount,
    targetLanguageCode: localized?.languageCode ?? null,
  }
}
