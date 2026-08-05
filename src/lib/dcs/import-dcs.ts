// DCS genesis import (spec §3, §7). Fetch a Door43 resource at a pinned ref,
// parse it through the routed parser, map every unit to a deterministic cell id
// (spec §5), and emit it into an adapter project's SOURCE lane via the existing
// bulk import front door (`bulkUploadSource`) — never raw inserts.
//
// The BulkImportCell.id is the DETERMINISTIC EVENT id `uuidv5(repo|sha|cellId)`,
// so re-running the same import dedupes through the server's idempotent /import.

import type { FileReference } from "@/lib/parsers/types"
import type { SourceArtifactFormat } from "../../../shared/import-contract"
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
  refs: FileReference[]
  skipped: { book: string; reason: string }[]
  cursor: DcsCursor
}

/** Standard RC manifest filename at the repo root. */
const MANIFEST_PATH = "manifest.yaml"
const MAX_DCS_SOURCE_FILES = 2_000
const MAX_DCS_SOURCE_CHARS = 20 * 1024 * 1024

function routeOwnsPath(routeId: string, path: string): boolean {
  const lower = path.toLowerCase()
  if (routeId === "usfm") return lower.endsWith(".usfm")
  if (routeId === "obs") return /(?:^|\/)\d+\.md$/.test(lower)
  if (routeId === "tsv-notes" || routeId === "tsv-questions") return lower.endsWith(".tsv")
  return false
}

/** Map a route id to the FileType the server projection groups by. */
type DcsFileType = Extract<SourceArtifactFormat, "usfm" | "obs" | "tsv">

function fileTypeForRoute(routeId: string): DcsFileType {
  if (routeId === "usfm") return "usfm"
  if (routeId === "obs") return "obs"
  if (routeId === "tsv-notes" || routeId === "tsv-questions") return "tsv"
  throw new Error(`Door43 route ${routeId} has no Aquilla file type mapping.`)
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
  const manifestYaml = await client.fetchRaw(owner, repoName, ref, MANIFEST_PATH, refKind, args.signal)
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
  const sourcePaths = tree.filter((path) => path !== MANIFEST_PATH && routeOwnsPath(route.id, path))
  if (sourcePaths.length > MAX_DCS_SOURCE_FILES) {
    throw new Error(`Door43 resource contains too many importable files (maximum ${MAX_DCS_SOURCE_FILES.toLocaleString()}).`)
  }
  const files = new Map<string, string>()
  for (const path of sourcePaths) {
    if (args.signal?.aborted) throw new Error("Import cancelled")
    const text = await client.fetchRaw(owner, repoName, ref, path, refKind, args.signal)
    if (text.length > MAX_DCS_SOURCE_CHARS) {
      throw new Error(`Door43 source member ${path} exceeds the 20 MB safety limit.`)
    }
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
  const refs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  for (const file of parsedFiles) {
    try {
      const cells = toBulkCells(file, args.projectId, repo, entry.commitSha)
      if (cells.length === 0) throw new Error(`${file.name} did not contain any importable content.`)
      const fileType = fileTypeForRoute(route.id)
      const meta: BulkImportFileMeta = {
        id: file.fileId,
        name: file.name,
        fileType,
        importFormat: route.id,
        parserVersion: `builtin:dcs-${route.id}@1`,
        ...(file.bookCode !== undefined ? { bookCode: file.bookCode } : {}),
      }
      // The exact source member is mandatory: reconstructed parser output is
      // not a safe substitute for round-trip/export provenance.
      const sourcePath = file.sourcePath ?? rawPathForFile(file, tree)
      const rawSource = files.get(sourcePath)
      if (rawSource === undefined) {
        throw new Error(`Import route ${route.id} did not retain the source member for ${file.name}.`)
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

/** Recover the repo path a parsed DcsFile came from so we can attach its raw
 *  bytes. The USFM route names files `BOOK (path)`; fall back to matching the
 *  path suffix in the file name, else the fileId-derived name. */
function rawPathForFile(file: DcsFile, tree: string[]): string {
  const m = file.name.match(/\(([^)]+)\)\s*$/)
  if (m && tree.includes(m[1])) return m[1]
  // Fall back: a tree path that the file name ends with (or equals).
  return tree.find((p) => file.name === p || file.name.endsWith(p)) ?? file.name
}
