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
import type { BulkImportCell } from "./bulk-import"

/** Kill switch: `VITE_IMPORT_VIA_REVISIONS=0` restores the N-event import. */
export const REVISION_IMPORT_ENABLED: boolean = import.meta.env?.VITE_IMPORT_VIA_REVISIONS !== "0"

/** The formats whose fresh imports go through the revisions route: exactly the
 *  ones wrapped onto the filter contract (AQU-2384), so a stamp names a walk
 *  that can be re-run. */
export const REVISION_IMPORT_FORMATS: ReadonlySet<string> = new Set(FORMAT_DESCRIPTORS.map((d) => d.id))

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
      sequenceIndex: cell.sequenceIndex ?? index,
      ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
    }
  })
}

/** True when this import can travel as a revision instead of N cell events. */
export function canImportAsRevision(args: {
  fileType: string | undefined
  isReimport: boolean
  hasTargets: boolean
  hasOriginalBytes: boolean
  cells: readonly BulkImportCell[]
}): boolean {
  if (!REVISION_IMPORT_ENABLED) return false
  if (!args.fileType || !REVISION_IMPORT_FORMATS.has(args.fileType)) return false
  // Re-import keeps its reconcile path for now (increment 3 covers fresh
  // imports); bilingual and media imports carry rows the revision has no
  // slot for.
  if (args.isReimport || args.hasTargets || !args.hasOriginalBytes) return false
  return args.cells.every((cell) => (cell.medium ?? "text") === "text" && cell.startMs === undefined)
}

export interface RevisionImport {
  /** `<filterId>@<walk>` — the file's parserVersion. */
  stamp: string
  optionsHash?: string
  units: RevisionUnitInput[]
}

export interface PostFileRevisionArgs {
  projectId: string
  fileId: string
  artifactSha256: string
  revision: RevisionImport
  origin?: "import" | "reimport"
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
}

export async function postFileRevision(args: PostFileRevisionArgs): Promise<FileRevisionResult> {
  const fetchFn = args.fetchImpl ?? fetch
  const url = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/revisions`
  const body = JSON.stringify({
    artifactSha256: args.artifactSha256,
    stamp: args.revision.stamp,
    ...(args.revision.optionsHash ? { optionsHash: args.revision.optionsHash } : {}),
    origin: args.origin ?? "import",
    units: args.revision.units,
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
