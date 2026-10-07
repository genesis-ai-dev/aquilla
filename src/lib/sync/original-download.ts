// Download the exact imported source blob (not the translation-injected
// export). Pair of sync-worker routes:
//   GET /api/v1/projects/:id/files/:fileId/original
//   GET /api/v1/projects/:id/export/originals
//
// Same save path as source-export / export-bundle: mint a token, fetch with
// Authorization, `res.blob()`, then `<a download>` on a same-origin blob URL.
// Do not navigate to the worker URL — Chromium ignores Content-Disposition
// across `:5173` → `:8789` and names the file with a UUID.

import { humanOriginalDownloadName } from "../../../shared/import-contract"
import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { fetchSyncToken } from "./sync-token"

export class OriginalDownloadError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "OriginalDownloadError"
    this.status = status
  }
}

/** Chrome ignores `a.download` when the value has path separators. */
export function safeDownloadFilename(filename: string): string {
  const cleaned = filename.replace(/[/\\:\0]/g, "-").replace(/^\.+/, "").trim()
  return cleaned || "original"
}

function artifactFormat(format?: string): string {
  if (!format || format === "custom") return "custom-original"
  return format
}

/** Browser-save name for an original blob, from the name already shown in the UI. */
export function originalDownloadLabel(
  fileName: string,
  format?: string,
  originalName?: string,
): string {
  return safeDownloadFilename(
    humanOriginalDownloadName(fileName, artifactFormat(format), originalName),
  )
}

export function originalsZipDownloadName(projectName: string): string {
  const safe = projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return `${safe || "project"}-originals.zip`
}

function originalUrl(projectId: string, fileId: string): string {
  return `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/original`
}

function originalsZipUrl(projectId: string): string {
  return `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/export/originals`
}

function triggerDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export interface DownloadOriginalArgs {
  projectId: string
  fileId: string
  downloadName: string
  getToken: (fileId: string) => Promise<string | null>
}

export async function downloadOriginalFile(args: DownloadOriginalArgs): Promise<void> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new OriginalDownloadError("Couldn't get an export token — sign in and try again.")
  const res = await fetch(originalUrl(args.projectId, args.fileId), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new OriginalDownloadError(
      detail || `Download failed (HTTP ${res.status})`,
      res.status,
    )
  }
  const blob = await res.blob()
  triggerDownload(blob, args.downloadName)
}

export interface DownloadOriginalsZipArgs {
  projectId: string
  projectName: string
  jwt: string
  fileId: string
}

export async function downloadOriginalsZip(args: DownloadOriginalsZipArgs): Promise<void> {
  const { token } = await fetchSyncToken(args.jwt, args.projectId, args.fileId)
  const res = await fetch(originalsZipUrl(args.projectId), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new OriginalDownloadError(
      detail || `Download failed (HTTP ${res.status})`,
      res.status,
    )
  }
  const blob = await res.blob()
  triggerDownload(blob, originalsZipDownloadName(args.projectName))
}
