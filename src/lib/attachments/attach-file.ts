// AQU-777: attach a picked file to a cell — validate, PUT the bytes to R2,
// then emit `cell.attachment.add`.
//
// A plain async function, not a hook, for the same reasons its audio sibling
// (src/lib/audio/attach-file.ts) is one: it touches no React state, each caller
// owns its own uploading/error UI, and a plain function is testable without a
// renderer.
//
// The ORDER below is the contract and must not be reversed: bytes first, event
// second. A projected row always points at an object that exists, so a reader
// never has to handle "the row is here but the image 404s". The cost is a
// possible orphan when the emit fails, which the catch below cleans up.

import { v7 as uuidv7 } from "uuid"
import type { FrontierSession } from "@/lib/frontier/types"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { emitCellAttachmentAdd, emitCellAttachmentRemove } from "@/lib/sync/events-emit"
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  attachmentExtForMime,
  deleteCellAttachment,
  uploadCellAttachment,
} from "@/lib/attachments/upload"

/**
 * `accept` for the hidden `<input type="file">`. Extensions are listed
 * alongside the MIME types for the same reason the audio picker lists them:
 * some mobile browsers report an empty or wrong type for files off the camera
 * roll, and an `accept` of types alone hides those files from the picker
 * entirely.
 */
export const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,application/pdf," +
  ".png,.jpg,.jpeg,.gif,.webp,.avif,.pdf"

/** One copy of the offline message, as the audio path keeps one. */
export const OFFLINE_MESSAGE =
  "You're offline — attachments can't be saved without a connection. Reconnect and try again."

const mb = (n: number) => Math.round(n / (1024 * 1024))

/**
 * Map a picked file to the Content-Type it will be stored under, or null when
 * it is not an allowed kind.
 *
 * Extension-based recovery is deliberate and narrow. `file.type` is empty or
 * wrong often enough on mobile that trusting it alone would refuse perfectly
 * good camera-roll screenshots — but recovery only ever maps to a type on the
 * allow-list, so a `.svg` or a renamed `.html` cannot reach R2 through it.
 * This is a declared-type check, not a content sniff: a renamed `.txt` with a
 * `.png` extension still gets through and lands as a broken image. That is the
 * same honest limit the audio validator documents, and closing it needs a real
 * magic-byte read, which is out of scope here.
 */
export function resolveAttachmentContentType(file: File): string | null {
  const declared = file.type.split(";")[0].trim().toLowerCase()
  if (ALLOWED_ATTACHMENT_MIME_TYPES.has(declared)) return declared

  const dot = file.name.lastIndexOf(".")
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : ""
  switch (ext) {
    case "png": return "image/png"
    case "jpg":
    case "jpeg": return "image/jpeg"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    case "avif": return "image/avif"
    case "bmp": return "image/bmp"
    case "tif":
    case "tiff": return "image/tiff"
    case "pdf": return "application/pdf"
    default: return null
  }
}

/**
 * Refuse a pick that cannot become a usable attachment. Returns null when the
 * file is acceptable, otherwise the message to show the user.
 */
export function validateAttachmentFile(file: File): string | null {
  if (file.size === 0) {
    return "That file is empty."
  }
  if (!resolveAttachmentContentType(file)) {
    return "That file type isn't supported — attach a PNG, JPEG, GIF, WebP, AVIF or PDF."
  }
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    return `That file is ${mb(file.size)} MB — the limit is ` +
      `${mb(MAX_ATTACHMENT_UPLOAD_BYTES)} MB. Try a smaller image.`
  }
  return null
}

export interface AttachFileToCellArgs {
  session: FrontierSession | null
  projectId: string
  fileId: string
  cellId: string
  file: File
  /** Author attribution for the cell.attachment.add event. */
  username: string
}

export interface AttachFileToCellResult {
  attachmentId: string
  objectName: string
  name: string
  mimeType: string
  sizeBytes: number
}

/**
 * Upload `file` to R2 and attach it to `cellId`. Throws with a
 * user-presentable message on every failure; the caller owns the busy/error UI.
 */
export async function attachFileToCell(
  args: AttachFileToCellArgs,
): Promise<AttachFileToCellResult> {
  const { session, projectId, fileId, cellId, file, username } = args

  // Hard front gate, not a retry. Attachment bytes can NEVER be queued
  // offline — the outbox carries JSON events only, and the bytes go straight
  // to R2 by fetch — so going ahead offline means three doomed retries ending
  // in a raw "TypeError: Failed to fetch". One clear sentence instead.
  if (!navigator.onLine) throw new Error(OFFLINE_MESSAGE)
  if (!session?.jwt) throw new Error("Sign in to attach files")

  const invalid = validateAttachmentFile(file)
  if (invalid) throw new Error(invalid)

  // Non-null: validateAttachmentFile above returns a message for every file
  // this resolves null for, so reaching here means it resolved.
  const contentType = resolveAttachmentContentType(file)!
  const attachmentId = uuidv7()
  const objectName = `${attachmentId}.${attachmentExtForMime(contentType)}`
  const getSyncToken = audioSyncTokenFetcherForSession(session)

  await uploadCellAttachment({
    projectId,
    fileId,
    objectName,
    blob: file,
    contentType,
    getSyncToken,
  })

  try {
    await emitCellAttachmentAdd({
      projectId,
      fileId,
      cellId,
      attachmentId,
      objectName,
      name: file.name,
      mimeType: contentType,
      sizeBytes: file.size,
      author: username,
    })
  } catch (emitErr) {
    // The R2 object uploaded fine but the attach event failed — delete it
    // rather than leaking storage, then re-throw so the user sees the real
    // error. The cleanup itself is non-fatal (F8's audio pattern).
    void deleteCellAttachment({ projectId, fileId, objectName, getSyncToken })
    throw emitErr
  }

  return { attachmentId, objectName, name: file.name, mimeType: contentType, sizeBytes: file.size }
}

export interface RemoveAttachmentArgs {
  session: FrontierSession | null
  projectId: string
  fileId: string
  cellId: string
  attachmentId: string
  objectName: string
  username: string
}

/**
 * Remove an attachment: soft-delete the projection row, then drop the R2
 * object.
 *
 * EVENT FIRST here, the mirror of attach's byte-first order, and for the same
 * reason — never leave a live row pointing at bytes that are gone. If the
 * object delete fails the row is already gone from every reader's view and the
 * orphan is invisible storage, which an admin sweep collects; if the order were
 * reversed, a failed emit would leave every collaborator with a link to a 404.
 */
export async function removeAttachmentFromCell(args: RemoveAttachmentArgs): Promise<void> {
  const { session, projectId, fileId, cellId, attachmentId, objectName, username } = args
  if (!session?.jwt) throw new Error("Sign in to remove attachments")

  await emitCellAttachmentRemove({ projectId, fileId, cellId, attachmentId, author: username })

  const getSyncToken = audioSyncTokenFetcherForSession(session)
  void deleteCellAttachment({ projectId, fileId, objectName, getSyncToken })
}
