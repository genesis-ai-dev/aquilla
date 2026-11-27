// AQU-2459: the client side of a file revision.
//
// A fresh import of a format that has a `FormatFilter` no longer sends N
// `source.cell.create` rows through /import. It creates the file row (an
// /import request with zero cells), preserves the original bytes (the sha256
// is the artifact id the revision names), and POSTs the parsed units once to
// the revisions route, which aligns them, writes ONE `file.revision` event and
// projects the cells set-based. `bulk-import.ts` drives that sequence; this
// module owns the unit mapping and the request.

import type { RevisionUnitInput } from "../../../db/shared/file-revision"
import { FORMAT_DESCRIPTORS } from "../formats/descriptors"
import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { BulkImportCell, BulkImportFileMeta } from "./bulk-import"

/** Kill switch: `VITE_IMPORT_VIA_REVISIONS=0` restores the N-event import. */
export const REVISION_IMPORT_ENABLED: boolean = import.meta.env?.VITE_IMPORT_VIA_REVISIONS !== "0"

/** Kill switch: `VITE_VIRTUAL_SOURCE_CELLS=0` falls back to Phase A (writes `cells` rows). */
export const VIRTUAL_SOURCE_CELLS_ENABLED: boolean = import.meta.env?.VITE_VIRTUAL_SOURCE_CELLS !== "0"

/** The formats whose fresh imports go through the revisions route: the
 *  filter-contract formats (AQU-2384) plus `usfm` (Paratext/USFM virtual
 *  source tracer bullet, AQU-2459 Phase B). */
export const REVISION_IMPORT_FORMATS: ReadonlySet<string> = new Set([
  ...FORMAT_DESCRIPTORS.map((d) => d.id),
  "usfm",
])

/** Locator kinds whose unit key encodes a position (so they pair by alignment,
 *  not by key). Everything else is reference-addressed. */
const POSITIONAL_LOCATORS: ReadonlySet<string> = new Set(["package-block", "sequence", "cue", "idml"])

interface ImportEnvelope {
  unitKey?: unknown
  sourceLocator?: { kind?: unknown } | null
}

/**
 * Map the cells the importer already built to revision units. The unit key is
 * the normalized manifest's `aquillaImport.unitKey`, which re-import already
 * matches on; the cell id the importer minted is dropped — the server derives
 * identity from alignment.
 */
export function revisionUnitsFromCells(cells: readonly BulkImportCell[]): RevisionUnitInput[] {
  const seen = new Map<string, number>()
  return cells.map((cell, index) => {
    const envelope = (cell.metadata?.aquillaImport ?? {}) as ImportEnvelope
    const baseKey = typeof envelope.unitKey === "string" && envelope.unitKey ? envelope.unitKey : `cell:${cell.cellId}`
    const n = (seen.get(baseKey) ?? 0) + 1
    seen.set(baseKey, n)
    const unitKey = n === 1 ? baseKey : `${baseKey}#${n}`
    const locatorKind = typeof envelope.sourceLocator?.kind === "string" ? envelope.sourceLocator.kind : null
    const positional = !cell.canonicalRef && (locatorKind === null || POSITIONAL_LOCATORS.has(locatorKind))
    return {
      unitKey,
      positional,
      text: cell.value,
      ...(cell.valueHtml !== undefined ? { html: cell.valueHtml } : {}),
      ...(cell.type !== undefined ? { type: cell.type } : {}),
      ...(cell.canonicalRef !== undefined ? { canonicalRef: cell.canonicalRef } : {}),
      ...(cell.medium !== undefined ? { medium: cell.medium } : {}),
      ...(cell.startMs !== undefined ? { startMs: cell.startMs } : {}),
      ...(cell.endMs !== undefined ? { endMs: cell.endMs } : {}),
      ...(cell.paragraphStart !== undefined ? { paragraphStart: cell.paragraphStart } : {}),
      sequenceIndex: cell.sequenceIndex ?? index,
      ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
    }
  })
}

/** True when this import can travel as a revision instead of N cell events. */
export function canImportAsRevision(args: {
  fileType: string | undefined
  /** `update` is the plain "Update existing" re-import, which a revision
   *  covers. The sidebar review apply and "Make updated copy" (fork) still go
   *  through /import/reconcile: they unvalidate, repin and clone, which the
   *  revisions route does not do. */
  reimport: false | "update" | "review" | "fork"
  hasTargets: boolean
  hasOriginalBytes: boolean
  cells: readonly BulkImportCell[]
}): boolean {
  if (!REVISION_IMPORT_ENABLED) return false
  if (!args.fileType || !REVISION_IMPORT_FORMATS.has(args.fileType)) return false
  // Bilingual and media imports carry rows the revision has no slot for.
  if (args.reimport === "review" || args.reimport === "fork") return false
  if (args.hasTargets || !args.hasOriginalBytes) return false
  return args.cells.every((cell) => (cell.medium ?? "text") === "text" && cell.startMs === undefined)
}

export interface RevisionImport {
  /** `<filterId>@<walk>` — the file's parserVersion. */
  stamp: string
  optionsHash?: string
  units: RevisionUnitInput[]
  /** Which provider wrote it. Defaults to the caller's ("import"). */
  origin?: RevisionOrigin
  /** `cellId → unitKey` for cells this provider wrote before the file had
   *  revisions, so an adopted file pairs by the provider's key. */
  cellKeys?: Record<string, string>
}

export type RevisionOrigin = "import" | "reimport" | "dcs"

export interface PostFileRevisionArgs {
  projectId: string
  fileId: string
  artifactSha256: string
  revision: RevisionImport
  origin?: RevisionOrigin
  /** Align and report the counts; write nothing. */
  dryRun?: boolean
  /** Re-parse the artifact the head already names (a parser fix). */
  realign?: boolean
  /** Ask for `cellIds` (`unitKey → cellId`) in the result. */
  returnCellIds?: boolean
  /** Smart Extensions: the extension this revision is attributed to. */
  toolOrigin?: unknown
  /** Re-import only: merged into files.meta with the cells (import manifest,
   *  parserVersion), and the stored artifact the source pointer moves to. */
  file?: BulkImportFileMeta
  artifactId?: string
  rawSourceFormat?: string
  /** The caller sends the `/import` finalize next, which recomputes the
   *  file's counters; the route then skips its own copy of that scan. */
  finalizeFollows?: boolean
  /** AQU-2459 Phase B: store source cells solely in the R2 manifest (zero
   *  Postgres source cell inserts). Defaults to `VIRTUAL_SOURCE_CELLS_ENABLED`. */
  virtual?: boolean
  getToken: (fileId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface FileRevisionResult {
  noop: boolean
  revisionN: number
  eventId?: string
  adopted?: boolean
  counts?: { equal: number; changed: number; moved: number; inserted: number; deleted: number }
  unitCount?: number
  dryRun?: boolean
  cellIds?: Record<string, string>
}

export async function postFileRevision(args: PostFileRevisionArgs): Promise<FileRevisionResult> {
  const fetchFn = args.fetchImpl ?? fetch
  const url = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/revisions`
  const body = JSON.stringify({
    artifactSha256: args.artifactSha256,
    stamp: args.revision.stamp,
    ...(args.revision.optionsHash ? { optionsHash: args.revision.optionsHash } : {}),
    origin: args.origin ?? args.revision.origin ?? "import",
    units: args.revision.units,
    ...(args.file ? { file: args.file } : {}),
    ...(args.artifactId && args.rawSourceFormat
      ? { artifactId: args.artifactId, rawSourceFormat: args.rawSourceFormat }
      : {}),
    ...(args.finalizeFollows ? { finalizeFollows: true } : {}),
    ...(args.revision.cellKeys ? { cellKeys: args.revision.cellKeys } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(args.realign ? { realign: true } : {}),
    ...(args.returnCellIds ? { returnCellIds: true } : {}),
    ...((args.virtual ?? VIRTUAL_SOURCE_CELLS_ENABLED) ? { virtual: true } : {}),
    ...(args.toolOrigin !== undefined ? { toolOrigin: args.toolOrigin } : {}),
  })
  let token = await args.getToken(args.fileId)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
      body,
      signal: args.signal,
    })
    if (response.ok) return (await response.json()) as FileRevisionResult
    if (response.status === 401 && attempt === 0) {
      token = await args.getToken(args.fileId)
      if (token) continue
    }
    const detail = await response.text().catch(() => "")
    throw new Error(`Revision upload failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  throw new Error("Revision upload failed")
}
