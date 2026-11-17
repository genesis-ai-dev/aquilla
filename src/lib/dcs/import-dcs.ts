// DCS genesis import (spec §3, §7). Fetch a Door43 resource at a pinned ref,
// parse it through the routed parser, and write each file into an adapter
// project's SOURCE lane as ONE file revision (AQU-2459, `./revision.ts`) through
// the bulk import front door (`bulkUploadSource`) — never raw inserts.
//
// The file id is deterministic and project-scoped (AQU-1891); the server
// derives each cell id from the file id and the unit key. Re-running the same
// import finds the head already naming the same artifact and stamp, which is a
// no-op. Importing over a file from before revisions adopts it with its cell
// ids intact (the revision carries `cellKeys`).

import type { FileReference } from "@/lib/parsers/types"

import type { DcsCatalogEntry, DcsCursor, DcsTrackMode, DcsFile } from "./types"
import type { DcsClient } from "./catalog"
import type { BulkUploadArgs, BulkImportCell, BulkImportFileMeta } from "@/lib/sync/bulk-import"
import { bulkUploadSource } from "@/lib/sync/bulk-import"
import { fetchDcsSources, planDcsFiles } from "./import-plan"
import { dcsEventId } from "./cell-id"
import { buildCursor } from "./cursor"
import { dcsRevision } from "./revision"

/** Emit surface — defaults to the real bulk uploader, injectable for tests. */
export type EmitFn = (args: BulkUploadArgs) => Promise<void>

export interface ImportDcsArgs {
  entry: DcsCatalogEntry
  /** The adapter project to write the source lane into. */
  projectId: string
  client: DcsClient
  /** Defaults to `bulkUploadSource`. */
  emit?: EmitFn
  /** Mints a sync-token scoped to (projectId, fileId). */
  getToken: (fileId: string) => Promise<string | null>
  /** Persisted in the returned cursor. Defaults to "release". */
  trackMode?: DcsTrackMode
  /** Per-project front-matter opt-out (AQU-634). When true, book-name/title/TOC
   *  + intro-block cells are excluded from the imported USFM. Default: false. */
  excludeFrontMatter?: boolean
  onProgress?: (uploaded: number, total: number) => void
  signal?: AbortSignal
}

export interface ImportDcsSummary {
  files: number
  cells: number
  refs: FileReference[]
  skipped: { book: string; reason: string }[]
  cursor: DcsCursor
}

/** The file's cells in the bulk uploader's shape. With a revision the uploader
 *  sends none of them (the units travel once); they are what it counts for
 *  progress and what the summary reports. */
function toBulkCells(
  file: DcsFile,
  projectId: string,
  repo: string,
  sha: string,
): BulkImportCell[] {
  const cells: BulkImportCell[] = []
  let anchor: string | null = null
  for (const c of file.cells) {
    cells.push({
      id: dcsEventId(projectId, repo, sha, c.cellId),
      cellId: c.cellId,
      anchorCellId: anchor,
      value: c.value,
      ...(c.valueHtml !== undefined ? { valueHtml: c.valueHtml } : {}),
      type: c.type,
      ...(c.canonicalRef !== undefined ? { canonicalRef: c.canonicalRef } : {}),
      ...(c.sequenceIndex !== undefined ? { sequenceIndex: c.sequenceIndex } : {}),
      ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
    })
    anchor = c.cellId
  }
  return cells
}

/**
 * Import a Door43 resource into an adapter project as source cells.
 *
 * Pipeline: fetch manifest → parse → route → getTree → fetchRaw routed files →
 * route.parse() → one bulkUploadSource per file, carrying one revision. Returns a summary + the cursor to persist.
 */
export async function importDcsResource(args: ImportDcsArgs): Promise<ImportDcsSummary> {
  const emit = args.emit ?? bulkUploadSource
  const { entry, client } = args
  const repo = entry.fullName

  // 1–3. Manifest → route → tree → routed members → parse (import-plan.ts,
  // shared with the first-party Door43 importer extension: AQU-1937 parity).
  const fetched = await fetchDcsSources(client, entry, { signal: args.signal })
  const { planned, skipped } = planDcsFiles({
    entry,
    fetched,
    projectId: args.projectId,
    excludeFrontMatter: args.excludeFrontMatter,
  })

  // 4. Emit one bulk upload per parsed file.
  let totalCells = 0
  const refs: FileReference[] = []
  for (const { file, fileType, routeId, rawSource } of planned) {
    try {
      const cells = toBulkCells(file, args.projectId, repo, entry.commitSha)
      const revision = dcsRevision(file, routeId, { excludeFrontMatter: args.excludeFrontMatter })
      const meta: BulkImportFileMeta = {
        id: file.fileId,
        name: file.name,
        fileType,
        importFormat: routeId,
        parserVersion: revision.stamp,
        ...(file.bookCode !== undefined ? { bookCode: file.bookCode } : {}),
      }
      await emit({
        projectId: args.projectId,
        fileId: file.fileId,
        file: meta,
        cells,
        rawSource,
        rawSourceFormat: fileType,
        revision,
        getToken: args.getToken,
        ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      })
      totalCells += cells.length
      refs.push({
        id: file.fileId,
        name: file.name,
        type: fileType,
        createdAt: new Date().toISOString(),
        cellCount: cells.length,
        ...(file.bookCode ? { bookCode: file.bookCode } : {}),
      })
    } catch (error) {
      skipped.push({ book: file.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (refs.length === 0 && skipped.length > 0) {
    throw new Error(`Door43 import could not import any files: ${skipped[0].reason}`)
  }

  return {
    files: refs.length,
    cells: totalCells,
    refs,
    skipped,
    cursor: buildCursor(entry, args.trackMode ?? "release"),
  }
}
