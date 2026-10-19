// DCS genesis import (spec §3, §7). Fetch a Door43 resource at a pinned ref,
// parse it through the routed parser, map every unit to a deterministic cell id
// (spec §5), and emit it into an adapter project's SOURCE lane via the existing
// bulk import front door (`bulkUploadSource`) — never raw inserts.
//
// The BulkImportCell.id is the DETERMINISTIC EVENT id `uuidv5(repo|sha|cellId)`,
// so re-running the same import dedupes through the server's idempotent /import.
// Event ids AND file ids are project-scoped (AQU-1891), so the same resource can
// be imported into any number of projects without one landing on another's rows.

import type { FileReference } from "@/lib/parsers/types"

import type { DcsCatalogEntry, DcsCursor, DcsTrackMode, DcsFile } from "./types"
import type { DcsClient } from "./catalog"
import type { BulkUploadArgs, BulkImportCell, BulkImportFileMeta } from "@/lib/sync/bulk-import"
import { bulkUploadSource } from "@/lib/sync/bulk-import"
import { fetchDcsSources, planDcsFiles } from "./import-plan"
import { dcsEventId } from "./cell-id"
import { buildCursor } from "./cursor"

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

/** Turn a parsed DcsFile's cells into anchor-chained BulkImportCells whose ids
 *  are the deterministic per-revision, per-PROJECT EVENT ids (mirrors
 *  buildBulkCells). projectId scopes the event id so importing the same resource
 *  into two projects does not collide on the events-table PK. */
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
 * route.parse() → build anchor-chained BulkImportCells (deterministic ids) →
 * one bulkUploadSource per file. Returns a summary + the cursor to persist.
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
      const meta: BulkImportFileMeta = {
        id: file.fileId,
        name: file.name,
        fileType,
        importFormat: routeId,
        parserVersion: `builtin:dcs-${routeId}@1`,
        ...(file.bookCode !== undefined ? { bookCode: file.bookCode } : {}),
      }
      await emit({
        projectId: args.projectId,
        fileId: file.fileId,
        file: meta,
        cells,
        rawSource,
        rawSourceFormat: fileType,
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
