// Door43 as a unit provider for file revisions (AQU-2459, decision 0008).
//
// A Door43 file's source side is a revision chain like any other file's: each
// upstream release (or parser fix) is ONE `file.revision` per file, aligned on
// the server by unit key. This module owns what is Door43-specific:
//
//   - the unit list for a parsed file (`dcsRevision`), every unit
//     reference-addressed by the key its route gives it;
//   - `cellKeys`, the bridge for files imported BEFORE this: their cells carry
//     `dcsCellId(repo|unitKey)`, and telling the route so makes adoption pair
//     by that key instead of by canonical_ref + ordinal, which would move a
//     translation onto the wrong note when a sibling is inserted upstream;
//   - the update loop (`reviseDcsFiles`): fetch the members this project
//     holds, parse, store the original, post one revision each.
//
// The browser no longer reads the project's source cells to work out a delta,
// and writes no per-cell source events.

import { v7 as uuidv7 } from "uuid"
import { mapWithConcurrency } from "@/lib/concurrency"
import { optionsHash, type RevisionUnitInput } from "../../../db/shared/file-revision"
import { postFileRevision, type FileRevisionResult, type RevisionImport } from "@/lib/sync/revision-import"
import { sha256Hex, uploadSourceOriginal } from "@/lib/sync/source-upload"
import type { DcsCatalogEntry, DcsFile, DcsImportOptions } from "./types"
import { isDcsRawNotFound, type DcsClient, type RefKind } from "./catalog"
import { parseManifest } from "./manifest"
import { routeFor } from "./resource-map"
import { dcsFileId, dcsLegacyFileId } from "./cell-id"
import { MANIFEST_PATH, fileTypeForRoute } from "./import-plan"

/** The filter stamp of a Door43 route's parse. Bump the walk when a route's
 *  parser changes what it emits (decision 0001). */
export const dcsStamp = (routeId: string): string => `builtin:dcs-${routeId}@1`

/** Parse options that change WHICH units exist are part of the revision's
 *  identity. No options hashes like an import that sent none. */
export function dcsOptionsHash(options: DcsImportOptions | undefined): string | undefined {
  return options?.excludeFrontMatter ? optionsHash({ excludeFrontMatter: true }) : undefined
}

/**
 * A parsed Door43 file as one revision: its units, plus `cellKeys`, the keys
 * its pre-revision cells go by. A repeated unit key (a TSV with a duplicated row id) takes an
 * occurrence suffix, as every other importer's keys do, so one bad row cannot
 * fail the alignment of the whole file.
 */
export function dcsRevision(
  file: DcsFile,
  routeId: string,
  options?: DcsImportOptions,
): RevisionImport {
  const seen = new Map<string, number>()
  const cellKeys: Record<string, string> = {}
  const units: RevisionUnitInput[] = file.cells.map((cell, index) => {
    const n = (seen.get(cell.unitKey) ?? 0) + 1
    seen.set(cell.unitKey, n)
    const unitKey = n === 1 ? cell.unitKey : `${cell.unitKey}#dup${n}`
    if (n === 1) cellKeys[cell.cellId] = unitKey
    return {
      unitKey,
      positional: false,
      text: cell.value,
      ...(cell.valueHtml !== undefined ? { html: cell.valueHtml } : {}),
      type: cell.type,
      ...(cell.canonicalRef !== undefined ? { canonicalRef: cell.canonicalRef } : {}),
      sequenceIndex: cell.sequenceIndex ?? index,
      ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
    }
  })
  const hash = dcsOptionsHash(options)
  return { stamp: dcsStamp(routeId), ...(hash ? { optionsHash: hash } : {}), units, origin: "dcs", cellKeys }
}

/**
 * AQU-1891: which id this project holds a Door43 member under, or undefined
 * when it does not hold it. New imports derive `dcsFileId(project, repo,
 * path)`; imports from before the project scope hold the legacy id.
 */
export function resolveHeldFileId(
  heldFileIds: ReadonlySet<string>,
  projectId: string,
  repo: string,
  path: string,
): string | undefined {
  const scoped = dcsFileId(projectId, repo, path)
  if (heldFileIds.has(scoped)) return scoped
  const legacy = dcsLegacyFileId(repo, path)
  return heldFileIds.has(legacy) ? legacy : undefined
}

/**
 * AQU-1896: how much of the project's held source a run actually looked at.
 * Zero changes is only "nothing diverges" when `fetchedFiles > 0`.
 */
export interface DcsScan {
  /** Source files this project holds. */
  heldFiles: number
  /** Held files that resolved to a member of the ref being read. */
  resolvedFiles: number
  /** Resolved files whose bytes were actually read. A member that 404s at the
   *  ref is skipped rather than fatal, so this can be lower. */
  fetchedFiles: number
}

export interface DcsRevisionCounts {
  created: number
  updated: number
  removed: number
}

export interface ReviseDcsResult extends DcsRevisionCounts {
  scan: DcsScan
  /** Files whose head moved (or would, on a dry run). */
  revisedFiles: number
}

export interface ReviseDcsArgs {
  client: DcsClient
  projectId: string
  /** The ref to read: the newer release for an update, the pinned one for a repair. */
  entry: DcsCatalogEntry
  /** The ids of the files this project holds (not in Trash). */
  heldFileIds: ReadonlySet<string>
  /**
   * Members to consider. An update passes the files changed between the two
   * refs; a repair omits it and every held member of the tree is re-read.
   */
  paths?: readonly string[]
  /** The project's persisted `importExcludeFrontMatter` (AQU-686). */
  excludeFrontMatter?: boolean
  /** A repair re-parses the artifact each head already names, which is a
   *  no-op unless the route is told to align anyway. */
  repair?: boolean
  /** Report what would change; store and write nothing. */
  dryRun?: boolean
  getToken: (fileId: string) => Promise<string | null>
  signal?: AbortSignal
  /** Injectable for tests. */
  post?: typeof postFileRevision
  upload?: typeof uploadSourceOriginal
}

/** Raw member fetches in flight at once (AQU-1860). */
const RAW_FETCH_CONCURRENCY = 4

/**
 * Bring the Door43 files this project holds to `entry`'s content, one revision
 * per file.
 *
 * Scoped to held files: a release touches dozens of books, and a project that
 * imported one must ignore the rest. A member absent at the ref is skipped,
 * not fatal: the compare between two refs lists every path any commit in the
 * range touched, so a file renamed part-way through is listed and yet missing
 * (11 of 84 on WycliffeAssociates/en_udb v19-01...v19-10). Its cells are kept
 * rather than tombstoned on a guess. Every other failure aborts, so a
 * throttled upstream never reads as "nothing to do".
 *
 * A failure part-way leaves the files already revised at the new content. The
 * caller does not advance its cursor, and the re-run finds those files' heads
 * already naming the same artifact, which the route answers as a no-op.
 */
export async function reviseDcsFiles(args: ReviseDcsArgs): Promise<ReviseDcsResult> {
  const { client, entry, projectId, heldFileIds } = args
  const post = args.post ?? postFileRevision
  const upload = args.upload ?? uploadSourceOriginal
  const result: ReviseDcsResult = {
    created: 0,
    updated: 0,
    removed: 0,
    revisedFiles: 0,
    scan: { heldFiles: heldFileIds.size, resolvedFiles: 0, fetchedFiles: 0 },
  }
  if (heldFileIds.size === 0) return result

  const owner = entry.owner
  const repoName = entry.name
  const repo = entry.fullName
  const refKind: RefKind = entry.refType === "branch" ? "branch" : "tag"

  const candidates = (args.paths ?? (await client.getTree(owner, repoName, entry.ref))).filter(
    (path) => path !== MANIFEST_PATH && resolveHeldFileId(heldFileIds, projectId, repo, path) !== undefined,
  )
  result.scan.resolvedFiles = new Set(
    candidates.map((path) => resolveHeldFileId(heldFileIds, projectId, repo, path)),
  ).size
  if (candidates.length === 0) return result

  const manifest = parseManifest(await client.fetchRaw(owner, repoName, entry.ref, MANIFEST_PATH, refKind, args.signal))
  const route = routeFor(entry, manifest)
  if (!route) {
    throw new Error(`No import route for "${entry.subject}" (${entry.contentFormat}); cannot read this Door43 resource.`)
  }

  const texts = await mapWithConcurrency(candidates, RAW_FETCH_CONCURRENCY, async (path) => {
    if (args.signal?.aborted) throw new Error("Door43 update cancelled")
    try {
      return await client.fetchRaw(owner, repoName, entry.ref, path, refKind, args.signal)
    } catch (error) {
      if (isDcsRawNotFound(error)) return null
      throw error
    }
  })
  const files = new Map<string, string>()
  candidates.forEach((path, i) => {
    const text = texts[i]
    if (text !== null) files.set(path, text)
  })
  result.scan.fetchedFiles = files.size

  const options: DcsImportOptions = { excludeFrontMatter: args.excludeFrontMatter }
  const parsed = route.parse({ entry, manifest, projectId, files, options })
  const format = fileTypeForRoute(route.id)

  for (const file of parsed) {
    if (args.signal?.aborted) throw new Error("Door43 update cancelled")
    // A parse that yields nothing is far more likely a parser or upstream
    // fault than a book whose every verse was removed; never tombstone a
    // whole file on it.
    if (file.cells.length === 0 || file.sourcePath === undefined) continue
    const fileId = resolveHeldFileId(heldFileIds, projectId, repo, file.sourcePath)
    const raw = files.get(file.sourcePath)
    if (fileId === undefined || raw === undefined) continue

    const revision = dcsRevision(file, route.id, options)
    const bytes = new TextEncoder().encode(raw).buffer as ArrayBuffer
    let stored: { artifactId: string; rawSourceFormat: string } | undefined
    let artifactSha256: string
    if (args.dryRun) {
      artifactSha256 = await sha256Hex(bytes)
    } else {
      // Stored without moving the source pointer; the revision moves it in
      // the same batch as the cells.
      const uploaded = await upload({
        projectId,
        fileId,
        artifactId: uuidv7(),
        bytes,
        format,
        artifactName: file.name,
        profileId: revision.stamp.split("@")[0],
        profileVersion: revision.stamp.split("@")[1],
        updateSourceSidecar: false,
        getToken: args.getToken,
        signal: args.signal,
      })
      artifactSha256 = uploaded.sha256
      stored = { artifactId: uploaded.artifactId, rawSourceFormat: format }
    }
    const out: FileRevisionResult = await post({
      projectId,
      fileId,
      artifactSha256,
      revision,
      ...(stored ?? {}),
      ...(args.repair ? { realign: true } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
      getToken: args.getToken,
      signal: args.signal,
    })
    if (out.noop || !out.counts) continue
    const changed = out.counts.inserted + out.counts.changed + out.counts.deleted
    result.created += out.counts.inserted
    result.updated += out.counts.changed
    result.removed += out.counts.deleted
    if (changed > 0 || !args.dryRun) result.revisedFiles++
  }
  return result
}
