// SDBH lexicon import orchestration: MARBLE JSON editions → per-letter source
// files (+ the domain-label file), optionally pre-filling the target column
// from a localized edition. Mirrors the paired-import flow: bulkUploadSource
// seeds the source cells, then enqueueTargetCommits chains one
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
  publishStagedImport,
  type TargetCommit,
} from "./sync/bulk-import"
import { assertSourceUploadSize, bindSourceArtifact, uploadSourceOriginal } from "./sync/source-upload"

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
  skipped: { book: string; reason: string }[]
  entryCount: number
  senseCount: number
  sourceCellCount: number
  targetCellCount: number
  /** Language code found in the localized edition's senses (e.g. "es"). */
  targetLanguageCode: string | null
}

export interface SdbhSourceArtifacts {
  master: { name: string; bytes: ArrayBuffer }
  localized?: { name: string; bytes: ArrayBuffer }
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
  sourceArtifacts?: SdbhSourceArtifacts,
): Promise<SdbhImportSummary> {
  onProgress?.({ phase: "parse" })
  const masterEntries = parseEntries(masterJson, "The master edition file")
  const parsed = parseSdbhLexicon(masterEntries)

  const localized = localizedJson
    ? extractSdbhLocalized(parseEntries(localizedJson, "The localized edition file"))
    : null

  const files: SdbhParsedFile[] = [...parsed.files, parsed.domainFile]
  const refs: FileReference[] = []
  const staged: Array<{ fileId: string; name: string }> = []
  let sourceCellCount = 0
  let targetCellCount = 0

  const masterBytes = sourceArtifacts?.master.bytes
    ?? new TextEncoder().encode(masterJson).buffer as ArrayBuffer
  const localizedBytes = localizedJson === null
    ? undefined
    : sourceArtifacts?.localized?.bytes
      ?? new TextEncoder().encode(localizedJson).buffer as ArrayBuffer
  assertSourceUploadSize(masterBytes)
  if (localizedBytes) assertSourceUploadSize(localizedBytes)

  for (let i = 0; i < files.length; i++) {
    const parsedFile = files[i]
    const fileId = uuidv7()
    const cells = buildBulkCells(parsedFile.strings, {
      fileName: parsedFile.name,
      fileType: "sdbh",
      profileId: "builtin:sdbh",
      profileVersion: "1",
    })
    const targets: TargetCommit[] = []
    if (localized) {
      for (const cell of cells) {
        const value = localized.byCellId.get(cell.cellId)
        if (value) targets.push({ id: uuidv7(), cellId: cell.cellId, parentId: cell.id, value })
      }
    }

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
      targets,
      targetLang: ctx.targetLang,
      deferPublication: true,
      getToken: ctx.getToken,
      signal: ctx.signal,
      onProgress: (uploaded, total) =>
        onProgress?.({ phase: "source", fileIndex: i + 1, fileCount: files.length, cellsEnqueued: uploaded, cellsTotal: total }),
    })
    sourceCellCount += cells.length
    targetCellCount += targets.length
    staged.push({ fileId, name: parsedFile.name })

    refs.push({
      id: fileId,
      name: parsedFile.name,
      type: "sdbh",
      createdAt: new Date().toISOString(),
      cellCount: cells.length,
      orderedBy: "sequence",
    })
  }

  const preserveEdition = async (
    name: string,
    bytes: ArrayBuffer,
    format: "sdbh-master" | "sdbh-localized",
  ): Promise<void> => {
    const first = staged[0]
    if (!first) return
    const artifactId = uuidv7()
    await uploadSourceOriginal({
      projectId: ctx.projectId,
      fileId: first.fileId,
      artifactId,
      bytes,
      format,
      artifactName: name,
      bindingRole: "support",
      memberPath: first.name,
      profileId: "builtin:sdbh",
      profileVersion: "1",
      fidelity: "preserved-only",
      updateSourceSidecar: false,
      getToken: ctx.getToken,
      signal: ctx.signal,
    })
    for (const binding of staged.slice(1)) {
      await bindSourceArtifact({
        projectId: ctx.projectId,
        fileId: binding.fileId,
        artifactId,
        memberPath: binding.name,
        profileId: "builtin:sdbh",
        profileVersion: "1",
        fidelity: "preserved-only",
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
    }
  }

  await preserveEdition(sourceArtifacts?.master.name ?? "SDBH-master.json", masterBytes, "sdbh-master")
  if (localizedBytes) {
    await preserveEdition(
      sourceArtifacts?.localized?.name ?? "SDBH-localized.json",
      localizedBytes,
      "sdbh-localized",
    )
  }
  const visibleRefs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  for (const file of staged) {
    try {
      await publishStagedImport({
        projectId: ctx.projectId,
        fileId: file.fileId,
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
      const ref = refs.find((candidate) => candidate.id === file.fileId)
      if (ref) visibleRefs.push(ref)
    } catch (error) {
      skipped.push({
        book: file.name,
        reason: `publication failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  if (visibleRefs.length === 0 && skipped.length > 0) {
    throw new Error(`SDBH import could not publish any files: ${skipped[0].reason}`)
  }

  return {
    refs: visibleRefs,
    skipped,
    entryCount: parsed.entryCount,
    senseCount: parsed.senseCount,
    sourceCellCount,
    targetCellCount,
    targetLanguageCode: localized?.languageCode ?? null,
  }
}
