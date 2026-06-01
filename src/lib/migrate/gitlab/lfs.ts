// Git-LFS pointer parsing + batch download for the migration fetcher.
//
// A Codex clone commits its media as LFS *pointer* text files under
//   .project/attachments/pointers/**
// The real bytes live behind the GitLab LFS server. After cloning we walk the
// pointers tree, resolve each pointer to bytes via the LFS batch API, verify
// the sha256, and write the bytes to the mirror path under
//   .project/attachments/files/**
// so the existing importer (scripts/migrate.ts) finds real audio.
//
// Ported from frontier-authentication/src/git/GitService.ts:
//   - downloadLFSObject()         -> the batch->download->fetch flow
//   - getFilesPathForPointer()    -> pointersToFilesPath() here
// Auth to the LFS server is Basic base64("oauth2:" + gitlabToken), per spec.

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** A parsed git-LFS pointer: the object id (sha256 hex) and byte size. */
export interface LfsPointer {
  oid: string
  size: number
}

const POINTER_SIGNATURE = "git-lfs.github.com/spec/v1"

/**
 * Parse git-LFS pointer text into { oid, size }, or null if the text is not a
 * pointer. Pure + unit-tested. A pointer looks like:
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<64 lowercase hex>
 *   size <non-negative integer>
 * We require the version signature, a sha256 oid, and a size. Field order is
 * not assumed (the spec sorts keys but real files are tolerated either way).
 */
export function parseLfsPointer(text: string): LfsPointer | null {
  if (!text.includes(POINTER_SIGNATURE)) return null

  const oidMatch = text.match(/^\s*oid\s+sha256:([0-9a-fA-F]{64})\s*$/m)
  const sizeMatch = text.match(/^\s*size\s+(\d+)\s*$/m)
  if (!oidMatch || !sizeMatch) return null

  const size = Number(sizeMatch[1])
  if (!Number.isSafeInteger(size) || size < 0) return null

  return { oid: oidMatch[1].toLowerCase(), size }
}

/** True if the text content is a git-LFS pointer (not the real object). */
export function isLfsPointer(text: string): boolean {
  return parseLfsPointer(text) !== null
}

/**
 * Map a pointers-tree path to its parallel files-tree path. Pure +
 * unit-tested. Handles forward/back slashes and leading-slash variants exactly
 * like GitService.getFilesPathForPointer. Returns the input unchanged if it is
 * not under a pointers directory (defensive — callers should only pass pointer
 * paths).
 *
 * e.g. ".project/attachments/pointers/Story/audio.webm"
 *   -> ".project/attachments/files/Story/audio.webm"
 */
export function pointersToFilesPath(pointerRelativePath: string): string {
  const normalized = pointerRelativePath.replace(/\\/g, "/")
  return normalized
    .replace("/.project/attachments/pointers/", "/.project/attachments/files/")
    .replace(".project/attachments/pointers/", ".project/attachments/files/")
}

/** True if a (normalized) repo-relative path sits under the pointers dir. */
export function isPointerPath(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, "/")
    .includes(".project/attachments/pointers/")
}

/**
 * Compute the sha256 of bytes as lowercase hex. Pure + unit-tested; this is
 * the integrity check that the downloaded object actually matches its oid.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** True iff sha256(bytes) === expected oid (case-insensitive). */
export function verifyOid(bytes: Uint8Array, expectedOid: string): boolean {
  return sha256Hex(bytes) === expectedOid.toLowerCase()
}

/**
 * Build the `${cleanRepoUrl}.git/info/lfs` base for batch requests. Pure +
 * unit-tested. Per spec: take http_url_to_repo, drop a trailing ".git", then
 * re-append ".git". This normalizes whether or not the clone URL already ends
 * in .git so we never double-suffix.
 */
export function lfsServerUrl(httpUrlToRepo: string): string {
  const clean = httpUrlToRepo.replace(/\.git$/, "")
  return `${clean}.git/info/lfs`
}

/** Basic-auth header value for the GitLab LFS server: base64("oauth2:<tok>"). */
export function lfsAuthHeader(gitlabToken: string): string {
  return `Basic ${Buffer.from(`oauth2:${gitlabToken}`).toString("base64")}`
}

/** Shape of one object in an LFS batch response. */
interface LfsBatchObject {
  oid: string
  size: number
  actions?: {
    download?: { href: string; header?: Record<string, string> }
  }
  error?: { code: number; message: string }
}

interface LfsBatchResponse {
  objects?: LfsBatchObject[]
}

/**
 * Request download actions for a batch of LFS objects. POSTs to
 * `${lfsBase}/objects/batch` with the git-lfs content type and Basic auth.
 * Returns the raw objects array (each may carry actions.download.href or an
 * error). Throws only on a non-OK HTTP status (batch-level failure).
 */
export async function requestLfsBatch(
  lfsBase: string,
  gitlabToken: string,
  objects: LfsPointer[],
): Promise<LfsBatchObject[]> {
  const response = await fetch(`${lfsBase}/objects/batch`, {
    method: "POST",
    headers: {
      Authorization: lfsAuthHeader(gitlabToken),
      Accept: "application/vnd.git-lfs+json",
      "Content-Type": "application/vnd.git-lfs+json",
    },
    body: JSON.stringify({
      operation: "download",
      transfers: ["basic"],
      objects: objects.map((o) => ({ oid: o.oid, size: o.size })),
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `LFS batch request failed (${response.status} ${response.statusText})` +
        (detail ? `: ${detail.slice(0, 300)}` : ""),
    )
  }

  const data = (await response.json()) as LfsBatchResponse
  return data.objects ?? []
}

/**
 * Fetch a single LFS object's bytes from its resolved download action, then
 * verify the sha256 matches the oid. Throws on HTTP error or oid mismatch.
 */
export async function downloadLfsObjectBytes(
  obj: LfsBatchObject,
): Promise<Uint8Array> {
  if (obj.error) {
    throw new Error(
      `LFS object ${obj.oid} errored: ${obj.error.code} ${obj.error.message}`,
    )
  }
  const download = obj.actions?.download
  if (!download?.href) {
    throw new Error(`LFS object ${obj.oid} has no download action`)
  }

  const response = await fetch(download.href, {
    method: "GET",
    headers: { ...(download.header ?? {}) },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `LFS object download failed for ${obj.oid} ` +
        `(${response.status} ${response.statusText})` +
        (detail ? `: ${detail.slice(0, 200)}` : ""),
    )
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!verifyOid(bytes, obj.oid)) {
    throw new Error(
      `LFS integrity check failed for ${obj.oid}: ` +
        `downloaded sha256 ${sha256Hex(bytes)} != expected oid`,
    )
  }
  return bytes
}

/** One pointer discovered on disk, with its source + destination abs paths. */
export interface DiscoveredPointer {
  pointer: LfsPointer
  /** Absolute path of the pointer text file under pointers/. */
  pointerAbsPath: string
  /** Absolute path where real bytes belong under files/. */
  filesAbsPath: string
  /** Repo-relative pointers path (forward-slash normalized). */
  relativePath: string
}

/**
 * Recursively walk `<dir>/.project/attachments/pointers/` and parse every
 * pointer file found, computing each one's mirror destination under files/.
 * Files that don't parse as pointers are skipped (with the path collected in
 * `skipped`). Returns [] cleanly if the pointers dir is absent.
 */
export function discoverPointers(dir: string): {
  pointers: DiscoveredPointer[]
  skipped: string[]
} {
  const pointersRoot = path.join(dir, ".project", "attachments", "pointers")
  const pointers: DiscoveredPointer[] = []
  const skipped: string[] = []

  if (!fs.existsSync(pointersRoot)) {
    return { pointers, skipped }
  }

  const stack: string[] = [pointersRoot]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const dirents = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of dirents) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue

      const text = fs.readFileSync(abs, "utf8")
      const parsed = parseLfsPointer(text)
      const relativePath = path.relative(dir, abs).replace(/\\/g, "/")
      if (!parsed) {
        skipped.push(relativePath)
        continue
      }
      pointers.push({
        pointer: parsed,
        pointerAbsPath: abs,
        filesAbsPath: path.join(dir, pointersToFilesPath(relativePath)),
        relativePath,
      })
    }
  }

  return { pointers, skipped }
}

/** Progress/result summary for an LFS dereference pass. */
export interface DerefResult {
  total: number
  written: number
  skippedAlreadyPresent: number
  failures: Array<{ relativePath: string; oid: string; error: string }>
}

/**
 * Dereference all LFS pointers under `dir` into the parallel files/ tree.
 * Batches the batch-API requests (default 50) and downloads with modest
 * concurrency (default 8). Objects whose target already exists with the correct
 * size are skipped. Per-object failures are collected (not thrown) so one bad
 * blob doesn't sink the whole project; the caller decides how to report.
 */
export async function dereferenceLfs(
  dir: string,
  httpUrlToRepo: string,
  gitlabToken: string,
  options: {
    batchSize?: number
    concurrency?: number
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<DerefResult> {
  const { pointers } = discoverPointers(dir)
  const lfsBase = lfsServerUrl(httpUrlToRepo)
  const batchSize = options.batchSize ?? 50
  const concurrency = options.concurrency ?? 8

  const result: DerefResult = {
    total: pointers.length,
    written: 0,
    skippedAlreadyPresent: 0,
    failures: [],
  }

  // Skip pointers whose real bytes already sit at the destination with the
  // expected size (cheap idempotency for re-runs / partial fetches).
  const pending = pointers.filter((p) => {
    try {
      const stat = fs.statSync(p.filesAbsPath)
      if (stat.isFile() && stat.size === p.pointer.size) {
        result.skippedAlreadyPresent += 1
        return false
      }
    } catch {
      // not present -> needs download
    }
    return true
  })

  let processed = 0
  const reportProgress = () => {
    options.onProgress?.(
      processed + result.skippedAlreadyPresent,
      result.total,
    )
  }
  reportProgress()

  for (let i = 0; i < pending.length; i += batchSize) {
    const slice = pending.slice(i, i + batchSize)
    const byOid = new Map(slice.map((p) => [p.pointer.oid, p]))

    let batchObjects: LfsBatchObject[]
    try {
      batchObjects = await requestLfsBatch(
        lfsBase,
        gitlabToken,
        slice.map((p) => p.pointer),
      )
    } catch (error) {
      // Whole batch failed -> record a failure for each pointer in it.
      const message = error instanceof Error ? error.message : String(error)
      for (const p of slice) {
        result.failures.push({
          relativePath: p.relativePath,
          oid: p.pointer.oid,
          error: message,
        })
        processed += 1
      }
      reportProgress()
      continue
    }

    // Download the batch's objects with bounded concurrency.
    let cursor = 0
    const downloadWorker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++
        if (index >= batchObjects.length) return
        const obj = batchObjects[index]
        const discovered = byOid.get(obj.oid?.toLowerCase?.() ?? obj.oid)
        if (!discovered) {
          processed += 1
          reportProgress()
          continue
        }
        try {
          const bytes = await downloadLfsObjectBytes(obj)
          fs.mkdirSync(path.dirname(discovered.filesAbsPath), {
            recursive: true,
          })
          fs.writeFileSync(discovered.filesAbsPath, bytes)
          result.written += 1
        } catch (error) {
          result.failures.push({
            relativePath: discovered.relativePath,
            oid: discovered.pointer.oid,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          processed += 1
          reportProgress()
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, batchObjects.length) },
        () => downloadWorker(),
      ),
    )
  }

  return result
}
