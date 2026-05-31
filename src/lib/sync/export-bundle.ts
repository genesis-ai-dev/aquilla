// "Download the deliverable" — fetch the whole-project USFM bundle (.zip) from
// the sync-worker's GET /api/v1/projects/:id/export/bundle and save it. The
// route is maintainer-gated server-side (spec Q32); the UI hides the action
// for non-maintainers. Kept separate from source-export.ts (single-file flow).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { fetchSyncToken } from "./sync-token"

export class BundleExportError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "BundleExportError"
    this.status = status
  }
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

export interface DownloadBundleArgs {
  projectId: string
  projectName: string
  /** The caller's auth JWT — used to mint a project-scoped sync token. */
  jwt: string
  /** Any file in the project; only used so the minted sync token is scoped to
   *  this project (the bundle route checks the project, not the file). */
  fileId: string
}

export async function downloadProjectBundle(args: DownloadBundleArgs): Promise<void> {
  const { token } = await fetchSyncToken(args.jwt, args.projectId, args.fileId)
  const res = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}/export/bundle`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new BundleExportError(detail || `Export failed (HTTP ${res.status})`, res.status)
  }
  const blob = await res.blob()
  const safe = args.projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  triggerDownload(blob, `${safe || "project"}-deliverable.zip`)
}
