// DCS genesis import (spec §3, §7). Fetch a Door43 resource at a pinned ref,
// parse it through the routed parser, map every unit to a deterministic cell id
// (spec §5), and emit it into an adapter project's SOURCE lane via the existing
// bulk import front door (`bulkUploadSource`) — never raw inserts.
//
// The BulkImportCell.id is the DETERMINISTIC EVENT id `uuidv5(repo|sha|cellId)`,
// so re-running the same import dedupes through the server's idempotent /import.

import type { DcsCatalogEntry, DcsCursor, DcsTrackMode, DcsFile } from "./types"
import type { DcsClient, RefKind } from "./catalog"
import type { BulkUploadArgs, BulkImportCell, BulkImportFileMeta } from "@/lib/sync/bulk-import"
import { bulkUploadSource } from "@/lib/sync/bulk-import"
import { parseManifest } from "./manifest"
import { routeFor } from "./resource-map"
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
  cursor: DcsCursor
}

/** Standard RC manifest filename at the repo root. */
const MANIFEST_PATH = "manifest.yaml"

/** Map a route id to the FileType the server projection groups by. */
function fileTypeForRoute(routeId: string): string {
  // v1 only routes USFM; Slice E extends this map (obs/tsv/md).
  if (routeId === "usfm") return "usfm"
  return routeId
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
  const owner = entry.owner
  const repoName = entry.name
  const repo = entry.fullName
  const ref = entry.ref
  const refKind: RefKind = entry.refType === "branch" ? "branch" : "tag"

  // 1. Manifest → route.
  const manifestYaml = await client.fetchRaw(owner, repoName, ref, MANIFEST_PATH, refKind)
  const manifest = parseManifest(manifestYaml)
  const route = routeFor(entry, manifest)
  if (!route) {
    throw new Error(
      `No import route for "${entry.subject}" (${entry.contentFormat}); resource type not supported in v1.`,
    )
  }

  // 2. Fetch the repo tree, pull the raw bytes of every blob (the route filters
  //    which paths it actually parses). We skip the manifest itself.
  const tree = await client.getTree(owner, repoName, ref)
  const files = new Map<string, string>()
  for (const path of tree) {
    if (args.signal?.aborted) throw new Error("Import cancelled")
    if (path === MANIFEST_PATH) continue
    const text = await client.fetchRaw(owner, repoName, ref, path, refKind)
    files.set(path, text)
  }

  // 3. Parse → deterministic-id cells.
  const parsedFiles = route.parse({
    entry,
    manifest,
    files,
    options: { excludeFrontMatter: args.excludeFrontMatter },
  })

  // 4. Emit one bulk upload per parsed file.
  let totalCells = 0
  for (const file of parsedFiles) {
    const cells = toBulkCells(file, args.projectId, repo, entry.commitSha)
    const meta: BulkImportFileMeta = {
      id: file.fileId,
      name: file.name,
      fileType: fileTypeForRoute(route.id),
      importFormat: route.id,
      ...(file.bookCode !== undefined ? { bookCode: file.bookCode } : {}),
    }
    // The raw source bytes for this file (round-trip fidelity — USFM today).
    const rawSource = files.get(rawPathForFile(file, tree))

    await emit({
      projectId: args.projectId,
      fileId: file.fileId,
      file: meta,
      cells,
      ...(rawSource !== undefined ? { rawSource, rawSourceFormat: route.id } : {}),
      getToken: args.getToken,
      ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })
    totalCells += cells.length
  }

  return {
    files: parsedFiles.length,
    cells: totalCells,
    cursor: buildCursor(entry, args.trackMode ?? "release"),
  }
}

/** Recover the repo path a parsed DcsFile came from so we can attach its raw
 *  bytes. The USFM route names files `BOOK (path)`; fall back to matching the
 *  path suffix in the file name, else the fileId-derived name. */
function rawPathForFile(file: DcsFile, tree: string[]): string {
  const m = file.name.match(/\(([^)]+)\)\s*$/)
  if (m && tree.includes(m[1])) return m[1]
  // Fall back: a tree path that the file name ends with (or equals).
  return tree.find((p) => file.name === p || file.name.endsWith(p)) ?? file.name
}
