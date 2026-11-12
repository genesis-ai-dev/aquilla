// AQU-777: transport for per-cell file attachments, backed by sync-worker's R2
// bucket (`/attachments/:projectId/:fileId/:objectName`).
//
// The audio sibling of this file is src/lib/audio/upload.ts, and the retry /
// token-refresh shape below is deliberately the same: three attempts, back off
// [200, 800], retry the transient statuses, and re-mint the sync token once on
// a 401 (the file-scoped JWT has a 15-minute TTL, so a picker left open across
// lunch would otherwise fail on an expired token with no way back).
//
// Attachments ride the same R2 lifecycle as audio — an admin DELETE of a file
// wipes its whole prefix, and per-PR preview workers stay isolated through
// R2_KEY_PREFIX — so there is nothing extra to plumb here.

import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import type { SyncTokenForFile } from "@/lib/audio/upload"

export type { SyncTokenForFile }

/** Server-side upload cap. Mirrors MAX_ATTACHMENT_BYTES in
 *  sync-worker/src/cell-attachments.ts (the client can't import worker code) —
 *  keep the two in sync. */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Content types the worker will accept. Mirrors
 * ALLOWED_ATTACHMENT_CONTENT_TYPES in sync-worker/src/cell-attachments.ts.
 *
 * Checking it here too is not belt-and-braces for its own sake: without it the
 * user learns that a .svg is refused only after the whole file has gone up the
 * wire and come back a 415, which on a phone tether is a long wait for a "no".
 * The worker remains the authority — this copy only makes the "no" immediate.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "application/pdf",
])

export interface AttachmentUploadResult {
  /** `<attachmentId>.<ext>` — the R2 object name, and the form the projection
   *  row and every later lookup use. */
  objectName: string
  sizeBytes: number
}

function attachmentEndpoint(projectId: string, fileId: string, objectName: string): string {
  return (
    `${syncWorkerHttpOrigin()}/attachments/` +
    `${encodeURIComponent(projectId)}/` +
    `${encodeURIComponent(fileId)}/` +
    `${encodeURIComponent(objectName)}`
  )
}

/**
 * Extension for the R2 object name, derived from the file's declared MIME type
 * rather than from its filename.
 *
 * The audio path does the opposite (filename first, MIME as fallback) because
 * there the extension is cosmetic — it only has to round-trip. Here the stored
 * object is served back to a browser with the type it was uploaded under, and
 * the worker's allow-list is keyed on that type, so the name must follow the
 * type that was actually validated. Taking it from the filename would let
 * `screenshot.svg` (declared `image/png` by a hostile client, or simply
 * mislabelled by a mobile browser) sit in R2 under an .svg name.
 */
export function attachmentExtForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png"
    case "image/jpeg": return "jpg"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    case "image/avif": return "avif"
    case "image/bmp": return "bmp"
    case "image/tiff": return "tiff"
    case "application/pdf": return "pdf"
    default: return "bin"
  }
}

/** True when the stored object is one an `<img>` can render inline. PDFs are
 *  accepted uploads but get a link + icon, not a preview. */
export function isPreviewableAttachment(mimeType: string | null | undefined): boolean {
  return (mimeType ?? "").startsWith("image/")
}

export interface UploadCellAttachmentArgs {
  projectId: string
  fileId: string
  objectName: string
  blob: Blob
  /** The Content-Type to store under. Passed explicitly rather than read off
   *  `blob.type` so the caller's validated type — the one `objectName`'s
   *  extension was derived from — is the one that reaches R2. */
  contentType: string
  getSyncToken: SyncTokenForFile
  signal?: AbortSignal
  fetchFn?: typeof fetch
  retryDelaysMs?: readonly number[]
}

const ATTACHMENT_UPLOAD_ATTEMPTS = 3
const ATTACHMENT_UPLOAD_RETRY_DELAYS_MS = [200, 800] as const

function isRetryableAttachmentUploadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export async function uploadCellAttachment(
  args: UploadCellAttachmentArgs,
): Promise<AttachmentUploadResult> {
  const { projectId, fileId, objectName, blob, contentType, getSyncToken } = args
  if (blob.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    const mb = (n: number) => Math.round(n / (1024 * 1024))
    throw new Error(
      `This file is ${mb(blob.size)} MB — the limit is ` +
        `${mb(MAX_ATTACHMENT_UPLOAD_BYTES)} MB. Try a smaller image.`,
    )
  }
  let token = await getSyncToken(projectId, fileId)
  if (!token) {
    throw new Error("attachment upload: no sync token (not signed in or no project access)")
  }

  const fetchFn = args.fetchFn ?? fetch
  const delays = args.retryDelaysMs ?? ATTACHMENT_UPLOAD_RETRY_DELAYS_MS
  let lastError: Error | null = null
  for (let attempt = 0; attempt < ATTACHMENT_UPLOAD_ATTEMPTS; attempt++) {
    if (args.signal?.aborted) throw new Error("attachment upload cancelled")
    let res: Response | null = null
    try {
      res = await fetchFn(attachmentEndpoint(projectId, fileId, objectName), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
        },
        body: blob,
        signal: args.signal,
      })
    } catch (error) {
      if (args.signal?.aborted) throw new Error("attachment upload cancelled")
      lastError =
        error instanceof Error ? error : new Error(String(error), { cause: error })
    }
    if (res) {
      if (res.ok) return { objectName, sizeBytes: blob.size }
      const text = await res.text().catch(() => "")
      lastError = new Error(
        `attachment upload failed (${res.status}): ${text || res.statusText}`,
      )
      if (res.status === 401 && attempt < ATTACHMENT_UPLOAD_ATTEMPTS - 1) {
        const refreshed = await getSyncToken(projectId, fileId)
        if (refreshed) {
          token = refreshed
          continue
        }
      }
      if (!isRetryableAttachmentUploadStatus(res.status)) throw lastError
    }
    if (attempt < ATTACHMENT_UPLOAD_ATTEMPTS - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt] ?? 0))
    }
  }
  throw lastError ?? new Error("attachment upload failed")
}

export interface CellAttachmentObjectArgs {
  projectId: string
  fileId: string
  objectName: string
  getSyncToken: SyncTokenForFile
}

/**
 * Build a URL an `<img src>` can load directly. Image elements cannot send an
 * Authorization header, so the sync-token rides in `?t=` (GET-only on the
 * worker side). Returns null when no token is available (anonymous session or
 * no project access) — the caller renders the link without a preview rather
 * than a broken image.
 */
export async function getCellAttachmentUrl(
  args: CellAttachmentObjectArgs,
): Promise<string | null> {
  const { projectId, fileId, objectName, getSyncToken } = args
  const token = await getSyncToken(projectId, fileId)
  if (!token) return null
  return `${attachmentEndpoint(projectId, fileId, objectName)}?t=${encodeURIComponent(token)}`
}

/**
 * Delete an uploaded blob from R2. Used to clean up an orphan when the PUT
 * succeeded but the subsequent `cell.attachment.add` emit failed, mirroring
 * F8's audio cleanup. Non-fatal — a failure here is logged, never re-thrown
 * (the user already has the real error).
 */
export async function deleteCellAttachment(args: CellAttachmentObjectArgs): Promise<void> {
  const { projectId, fileId, objectName, getSyncToken } = args
  const token = await getSyncToken(projectId, fileId)
  if (!token) return // not signed in — an admin sweep collects the orphan

  await fetch(attachmentEndpoint(projectId, fileId, objectName), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch((e) => {
    console.warn("[attachments/delete] cleanup failed:", e)
  })
}
