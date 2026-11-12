// The Door43 import, split into its two pure-ish halves so that BOTH importers
// run the same code (AQU-1937):
//   - the built-in import (import-dcs.ts → bulkUploadSource), and
//   - the first-party Door43 importer EXTENSION (src/lib/dcs/extension/), which
//     runs these exact functions in its sandbox and writes through the public
//     files.upsert API.
// Same fetch, same route, same parse, same deterministic ids → the same files
// and cells, so a refresh through the extension lands on what the built-in
// import created and never orphans or re-stales a translation.

import type { DcsCatalogEntry, DcsFile, DcsManifest, ResourceRoute } from "./types"
import type { DcsClient, RefKind } from "./catalog"
import type { SourceArtifactFormat } from "../../../shared/import-contract"
import { parseManifest } from "./manifest"
import { routeFor } from "./resource-map"

/** Standard RC manifest filename at the repo root. */
export const MANIFEST_PATH = "manifest.yaml"
export const MAX_DCS_SOURCE_FILES = 2_000
export const MAX_DCS_SOURCE_CHARS = 20 * 1024 * 1024

export function routeOwnsPath(routeId: string, path: string): boolean {
  const lower = path.toLowerCase()
  if (routeId === "usfm") return lower.endsWith(".usfm")
  if (routeId === "obs") return /(?:^|\/)\d+\.md$/.test(lower)
  if (routeId === "tsv-notes" || routeId === "tsv-questions") return lower.endsWith(".tsv")
  return false
}

/** Map a route id to the FileType the server projection groups by. */
export type DcsFileType = Extract<SourceArtifactFormat, "usfm" | "obs" | "tsv">

export function fileTypeForRoute(routeId: string): DcsFileType {
  if (routeId === "usfm") return "usfm"
  if (routeId === "obs") return "obs"
  if (routeId === "tsv-notes" || routeId === "tsv-questions") return "tsv"
  throw new Error(`Door43 route ${routeId} has no Aquilla file type mapping.`)
}

/** The book code a repo path names ("57-TIT.usfm", "tn_TIT.tsv", …), or null. */
export function dcsBookOfPath(path: string): string | null {
  const base = path.split("/").pop() ?? path
  const m = /(?:^\d{2}-|^(?:tn|tq|twl|sn|sq)_)([1-3]?[A-Z]{2,3})\.(?:usfm|tsv)$/i.exec(base)
  return m ? m[1].toUpperCase() : null
}

export interface DcsFetched {
  manifest: DcsManifest
  route: ResourceRoute
  tree: string[]
  files: Map<string, string>
}

/** Manifest → route → tree → the routed members' raw text. `includePath`
 *  narrows which members are fetched (e.g. the chosen books). */
export async function fetchDcsSources(
  client: Pick<DcsClient, "fetchRaw" | "getTree">,
  entry: DcsCatalogEntry,
  opts: { signal?: AbortSignal; includePath?: (path: string) => boolean; onFetched?: (path: string, done: number, total: number) => void } = {},
): Promise<DcsFetched> {
  const refKind: RefKind = entry.refType === "branch" ? "branch" : "tag"
  const manifestYaml = await client.fetchRaw(entry.owner, entry.name, entry.ref, MANIFEST_PATH, refKind, opts.signal)
  const manifest = parseManifest(manifestYaml)
  const route = routeFor(entry, manifest)
  if (!route) {
    throw new Error(
      `No import route for "${entry.subject}" (${entry.contentFormat}); resource type not supported in v1.`,
    )
  }
  const tree = await client.getTree(entry.owner, entry.name, entry.ref)
  const sourcePaths = tree.filter(
    (path) => path !== MANIFEST_PATH && routeOwnsPath(route.id, path) && (!opts.includePath || opts.includePath(path)),
  )
  if (sourcePaths.length > MAX_DCS_SOURCE_FILES) {
    throw new Error(`Door43 resource contains too many importable files (maximum ${MAX_DCS_SOURCE_FILES.toLocaleString()}).`)
  }
  const files = new Map<string, string>()
  for (const [i, path] of sourcePaths.entries()) {
    if (opts.signal?.aborted) throw new Error("Import cancelled")
    const text = await client.fetchRaw(entry.owner, entry.name, entry.ref, path, refKind, opts.signal)
    if (text.length > MAX_DCS_SOURCE_CHARS) {
      throw new Error(`Door43 source member ${path} exceeds the 20 MB safety limit.`)
    }
    files.set(path, text)
    opts.onFetched?.(path, i + 1, sourcePaths.length)
  }
  return { manifest, route, tree, files }
}

export interface PlannedDcsFile {
  file: DcsFile
  fileType: DcsFileType
  routeId: string
  /** The exact repo member the file came from (round-trip/export provenance). */
  sourcePath: string
  rawSource: string
}

/** Parse fetched members into files with deterministic ids. A file that
 *  cannot be imported is reported in `skipped`, never thrown. */
export function planDcsFiles(args: {
  entry: DcsCatalogEntry
  fetched: DcsFetched
  projectId: string
  excludeFrontMatter?: boolean
}): { planned: PlannedDcsFile[]; skipped: { book: string; reason: string }[] } {
  const { entry, fetched } = args
  const parsedFiles = fetched.route.parse({
    entry,
    manifest: fetched.manifest,
    projectId: args.projectId,
    files: fetched.files,
    options: { excludeFrontMatter: args.excludeFrontMatter },
  })
  const planned: PlannedDcsFile[] = []
  const skipped: { book: string; reason: string }[] = []
  for (const file of parsedFiles) {
    try {
      if (file.cells.length === 0) throw new Error(`${file.name} did not contain any importable content.`)
      const fileType = fileTypeForRoute(fetched.route.id)
      const sourcePath = file.sourcePath ?? rawPathForFile(file, fetched.tree)
      const rawSource = fetched.files.get(sourcePath)
      if (rawSource === undefined) {
        throw new Error(`Import route ${fetched.route.id} did not retain the source member for ${file.name}.`)
      }
      planned.push({ file, fileType, routeId: fetched.route.id, sourcePath, rawSource })
    } catch (error) {
      skipped.push({ book: file.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { planned, skipped }
}

/** Recover the repo path a parsed DcsFile came from so we can attach its raw
 *  bytes. The USFM route names files `BOOK (path)`; fall back to matching the
 *  path suffix in the file name, else the fileId-derived name. */
function rawPathForFile(file: DcsFile, tree: string[]): string {
  const m = file.name.match(/\(([^)]+)\)\s*$/)
  if (m && tree.includes(m[1])) return m[1]
  return tree.find((p) => file.name === p || file.name.endsWith(p)) ?? file.name
}
