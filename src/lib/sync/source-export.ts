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
  /** Target-language lane to overlay. Empty/omitted selects the legacy lane. */
  targetLang?: string
  /**
   * AQU-1148: overlay only translations meeting the project's validation
   * threshold. A verse whose target is an unvalidated draft keeps the client's
   * own original words instead of shipping as approved text. Omitted/false is
   * today's contract: every current translation, validated or not.
   */
  validatedOnly?: boolean
}

function sourceExportUrl(
  projectId: string,
  fileId: string,
  targetLang?: string,
  mode?: "raw",
  validatedOnly?: boolean,
): string {
  const base =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/source`
  const params = new URLSearchParams()
  if (targetLang) params.set("lane", targetLang)
  if (mode) params.set("mode", mode)
  if (validatedOnly) params.set("validated", "1")
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
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
  const url = sourceExportUrl(args.projectId, args.fileId, args.targetLang, undefined, args.validatedOnly)

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
 *
 * NOTE: for USFM files this plain fetch re-serializes the stored source with
 * current default-lane translations injected — use `fetchRawOriginalSource`
 * when the byte-exact upload is wanted.
 */
export async function fetchSourceSidecar(
  args: Omit<DownloadSourceArgs, "downloadName">,
): Promise<ArrayBuffer> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new SourceExportError("Couldn't get an export token — sign in and try again.")
  const url = sourceExportUrl(args.projectId, args.fileId, args.targetLang)

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

/** One source cell this file has lost, as the server reports it. */
export interface RemovedCellRecord {
  cellId: string
  /** Verse address, for USFM. Null for every other format. */
  canonicalRef: string | null
  /** The cell's create-time metadata, verbatim. The package locator that docx
   *  and pptx export by lives inside it — decoded by `import-locators.ts`,
   *  which owns that shape. */
  metadata: Record<string, unknown> | null
}

/**
 * AQU-1068: which source cells did this file lose?
 *
 * The docx and pptx exporters patch translations into the client's original
 * package, and leave a paragraph alone when it has no translation. A REMOVED
 * cell has no translation either — its row is gone from the projection
 * entirely — so without this the two are indistinguishable and every removal is
 * silently undone at export. The USFM exporter runs on the server and reads the
 * event log directly; these two run in the browser and cannot.
 *
 * Returns an empty list on ANY failure rather than throwing. The worst case of
 * an empty list is today's behaviour, where a removed paragraph keeps the
 * client's original words; a throw would take the whole download with it.
 */
export async function fetchRemovedCells(args: {
  projectId: string
  fileId: string
  getToken: (fileId: string) => Promise<string | null>
}): Promise<RemovedCellRecord[]> {
  try {
    const token = await args.getToken(args.fileId)
    if (!token) return []
    const url =
      `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
      `/files/${encodeURIComponent(args.fileId)}/removed-cells`
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return []
    const body = (await res.json()) as { removed?: RemovedCellRecord[] }
    return Array.isArray(body.removed) ? body.removed : []
  } catch {
    return []
  }
}

/**
 * AQU-907: Fetch the byte-exact original upload via `?mode=raw` — no
 * translation overlay. `rawOriginal` reports whether the server actually
 * honored raw mode (X-Export-Mode: raw-original); a sync-worker that
 * predates the mode ignores the unknown param and returns the injected
 * serialization instead, and callers presenting the bytes as "the original
 * upload" must fall back to saying what they really got.
 */
export async function fetchRawOriginalSource(
  args: Omit<DownloadSourceArgs, "downloadName">,
): Promise<{ bytes: ArrayBuffer; rawOriginal: boolean }> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new SourceExportError("Couldn't get an export token — sign in and try again.")
  const url = sourceExportUrl(args.projectId, args.fileId, args.targetLang, "raw")

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
  return {
    bytes: await res.arrayBuffer(),
    rawOriginal: res.headers.get("X-Export-Mode") === "raw-original",
  }
}

/**
 * Fetch the translation-injected source TEXT for a file (USFM today — the
 * /source route substitutes current translations back into the original
 * markup server-side). Same endpoint as `fetchSourceSidecar`; text-returning
 * formats decode the body instead of keeping raw bytes.
 */
export async function fetchInjectedSourceText(
  args: Omit<DownloadSourceArgs, "downloadName">,
): Promise<string> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new SourceExportError("Couldn't get an export token — sign in and try again.")
  const url = sourceExportUrl(args.projectId, args.fileId, args.targetLang, undefined, args.validatedOnly)

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
  return res.text()
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
  /** Target-language lane to overlay in every exported USFM file. */
  targetLang?: string
  /** AQU-1148: overlay only validated translations in every exported file. */
  validatedOnly?: boolean
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
      const text = await fetchInjectedSourceText({
        projectId: args.projectId,
        fileId: file.id,
        getToken: args.getToken,
        targetLang: args.targetLang,
        validatedOnly: args.validatedOnly,
      })
      zip.file(downloadName, text)
    } catch (e) {
      // Same skip copy as before the fetchInjectedSourceText refactor: 404 is
      // the "re-import to enable" nudge, other HTTP failures stay terse.
      const reason = e instanceof SourceExportError && e.status === 404
        ? "no side-car raw bytes (file imported before round-trip support)"
        : e instanceof SourceExportError && e.status !== undefined
          ? `HTTP ${e.status}`
          : (e as Error).message
      skipped.push({ name: downloadName, reason })
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
