// Download an imported source file with current translations substituted back
// into the original markup. For USFM today; the worker route is generic on
// `format` so future formats (DOCX, PPTX) drop in here too.
//
// The export endpoint requires a sync token scoped to the project (viewer is
// enough). 404 means the file has no side-car raw bytes recorded — usually
// because it was imported before the v3 side-car path landed; the UI surfaces
// that as "re-import to enable export".

import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface DownloadSourceArgs {
  projectId: string
  fileId: string
  /** Suggested filename for the browser save dialog. The worker also sets
   *  Content-Disposition; this fallback only matters when the browser ignores
   *  it (rare). */
  downloadName: string
  getToken: (fileId: string) => Promise<string | null>
}

// erasableSyntaxOnly: parameter properties (`public readonly status`) use
// TypeScript-specific constructor syntax that is banned. We declare the field
// without an access modifier and assign it in the body — pure JS syntax that
// TypeScript type-checks but emits identically.

export class SourceExportError extends Error {
  /** HTTP status, when available — UI decides whether to nudge a re-import (404). */
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "SourceExportError"
    this.status = status
  }
}

export interface DownloadSourceResult {
  /** AQU-276: number of translated verses whose original USFM span contained
   *  intra-verse markers (footnotes, poetry, character markers) that were
   *  dropped by plain-text substitution. 0 = genuinely lossless round-trip.
   *  `null` if the server did not return the header (older route version). */
  lossyVerseCount: number | null
}

export async function downloadSourceFile(args: DownloadSourceArgs): Promise<DownloadSourceResult> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new SourceExportError("Couldn't get an export token — sign in and try again.")
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/files/${encodeURIComponent(args.fileId)}/source`

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new SourceExportError(
      detail || `Export failed (HTTP ${res.status})`,
      res.status,
    )
  }
  // AQU-276: read the lossy-verse count header before consuming the body.
  const lossyHeader = res.headers.get("X-Usfm-Lossy-Verse-Count")
  const lossyVerseCount = lossyHeader !== null ? parseInt(lossyHeader, 10) : null

  const blob = await res.blob()
  triggerDownload(blob, args.downloadName)
  return { lossyVerseCount }
}

/**
 * AQU-233: Fetch the raw source side-car bytes for a non-USFM file (e.g. DOCX).
 * The server returns the raw binary bytes with X-Export-Mode: raw-sidecar.
 * Returns an ArrayBuffer so the caller can do client-side XML injection.
 */
export async function fetchSourceSidecar(args: Omit<DownloadSourceArgs, "downloadName">): Promise<ArrayBuffer> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new SourceExportError("Couldn't get an export token — sign in and try again.")
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/files/${encodeURIComponent(args.fileId)}/source`

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new SourceExportError(
      detail || `Export failed (HTTP ${res.status})`,
      res.status,
    )
  }
  return res.arrayBuffer()
}

function triggerDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export interface DownloadProjectZipArgs {
  projectId: string
  projectName: string
  /** All files in the project; non-exportable types are filtered out. */
  files: { id: string; name: string; type: string }[]
  /** Per-file token mint — same signature as DownloadSourceArgs.getToken. */
  getToken: (fileId: string) => Promise<string | null>
  /** Optional progress hook: (done, total) after each file lands. */
  onProgress?: (done: number, total: number) => void
}

const EXPORTABLE = new Set(["usfm"])

/**
 * Fetch every exportable file in the project, zip them client-side, and
 * trigger a single browser download. Files that fail (404 = no side-car,
 * import predates the round-trip path) are skipped and reported via the
 * returned `skipped` list so the UI can surface them.
 *
 * Sequential by design: the dev sync-worker has a server_seq race under
 * concurrent imports that bleeds into reads, and even on prod, sequential
 * is friendly to small projects (the bottleneck is the user's browser zip
 * memory, not throughput).
 */
export async function downloadProjectZip(
  args: DownloadProjectZipArgs,
): Promise<{ exported: number; skipped: { name: string; reason: string }[] }> {
  const candidates = args.files.filter((f) => EXPORTABLE.has(f.type))
  if (candidates.length === 0) {
    throw new SourceExportError("This project has no exportable files (USFM).")
  }

  const JSZipMod = (await import("jszip")).default
  const zip = new JSZipMod()
  const skipped: { name: string; reason: string }[] = []
  let done = 0

  for (const file of candidates) {
    const downloadName = /\.(sfm|usfm)$/i.test(file.name) ? file.name : `${file.name}.SFM`
    try {
      const token = await args.getToken(file.id)
      if (!token) throw new SourceExportError("Couldn't get an export token.")
      const res = await fetch(
        `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
          `/files/${encodeURIComponent(file.id)}/source`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) {
        const detail = res.status === 404
          ? "no side-car raw bytes (file imported before round-trip support)"
          : `HTTP ${res.status}`
        skipped.push({ name: downloadName, reason: detail })
      } else {
        zip.file(downloadName, await res.text())
      }
    } catch (e) {
      skipped.push({ name: downloadName, reason: (e as Error).message })
    }
    done++
    args.onProgress?.(done, candidates.length)
  }

  const exported = candidates.length - skipped.length
  if (exported === 0) {
    throw new SourceExportError(
      `Couldn't export any files. First reason: ${skipped[0]?.reason ?? "unknown"}`,
    )
  }
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  const safeName = args.projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  triggerDownload(zipBlob, `${safeName || "project"}.zip`)
  return { exported, skipped }
}
