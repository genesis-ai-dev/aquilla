// Direct-to-R2 multipart upload for large audio / video objects (AQU-1853).
//
// The single-shot `PUT /audio/...` path sends the whole file as one request
// body, which the Worker buffers and hashes in the isolate — so it is capped at
// MAX_AUDIO_UPLOAD_BYTES (95 MB, under the 100 MB Workers request limit) and
// feature-length or 1080p media is simply rejected.
//
// This uploader splits the blob into parts and sends one part per request into
// an R2 multipart upload, so neither side ever holds more than a single part:
//
//   1. POST   ?multipart=create    -> uploadId (+ the server's part size)
//   2. PUT    ?multipart=part      -> one { partNumber, etag } per part
//   3. POST   ?multipart=complete  -> R2 assembles the object; artifact rows land
//   (   DELETE ?multipart=abort    -> on a fatal error, so no parts dangle )
//
// Resume: each part is retried on its own with backoff, and parts already
// acknowledged are never re-sent. A network drop mid-upload therefore resumes
// at the part that failed rather than restarting the whole transfer.
//
// The object's SHA-256 is hashed incrementally while the parts are read (see
// `@/lib/hash/sha256-stream`) and sent on `complete`, because a Worker cannot
// hash a multi-gigabyte object without re-reading it. It is computed only when
// an `artifactId` is supplied — that is the only case the server needs it for
// (the `artifacts.sha256` column), and hashing in JS is not free.

import { Sha256Stream } from "@/lib/hash/sha256-stream"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import type { AudioUploadResult, SyncTokenForFile } from "@/lib/audio/upload"
// `upload.ts` reaches this module through a dynamic import, so this direction
// is the only static edge — no import cycle.
import { MAX_AUDIO_OBJECT_BYTES, buildFrontierAudioUrl } from "@/lib/audio/upload"

/** Fallback part size when the server does not advertise one. Mirrors
 *  AUDIO_UPLOAD_PART_BYTES in sync-worker/src/audio-multipart.ts. */
export const AUDIO_MULTIPART_PART_BYTES = 16 * 1024 * 1024

/** R2's hard limit on parts per multipart upload. Mirrors MAX_AUDIO_PARTS in
 *  sync-worker/src/audio-multipart.ts. */
export const MAX_AUDIO_PARTS = 10_000

// Budget sized against the acceptance criterion "interrupt the network for
// 30 s, restore it, and the upload resumes": the backoff alone spans ~31 s, and
// `waitForOnline` below usually makes the wait end the moment the connection is
// actually back rather than on the next scheduled retry.
const PART_ATTEMPTS = 6
const PART_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const

/** Cap on how long a single retry will sit waiting for the network to return. */
const MAX_OFFLINE_WAIT_MS = 60_000

/**
 * Resolve as soon as the browser reports it is back online (or after `capMs`,
 * or if the upload is cancelled). A no-op when the environment has no
 * connectivity signal or already reports itself online, so the caller's
 * ordinary backoff is what governs then.
 */
async function waitForOnline(signal: AbortSignal | undefined, capMs: number): Promise<void> {
  const nav = globalThis.navigator as (Navigator & { onLine?: boolean }) | undefined
  const target = globalThis as unknown as EventTarget
  if (!nav || typeof nav.onLine !== "boolean" || nav.onLine) return
  if (typeof target.addEventListener !== "function") return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      target.removeEventListener("online", finish)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, capMs)
    target.addEventListener("online", finish)
    signal?.addEventListener("abort", finish)
  })
}

export interface MultipartUploadProgress {
  uploadedBytes: number
  totalBytes: number
  /** 1-based index of the part just acknowledged. */
  partNumber: number
  partCount: number
}

export interface UploadCellAudioMultipartArgs {
  projectId: string
  fileId: string
  audioId: string
  ext: string
  blob: Blob
  artifactId?: string
  artifactName?: string
  getSyncToken: SyncTokenForFile
  signal?: AbortSignal
  fetchFn?: typeof fetch
  retryDelaysMs?: readonly number[]
  /** Override the part size (tests, and a client that knows better). */
  partSizeBytes?: number
  onProgress?: (progress: MultipartUploadProgress) => void
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function multipartEndpoint(
  projectId: string,
  fileId: string,
  audioId: string,
  ext: string,
  params: Record<string, string>,
): string {
  const objectName = `${audioId}.${ext}`
  const query = new URLSearchParams(params).toString()
  return (
    `${syncWorkerHttpOrigin()}/audio/`
    + `${encodeURIComponent(projectId)}/`
    + `${encodeURIComponent(fileId)}/`
    + `${encodeURIComponent(objectName)}?${query}`
  )
}

/**
 * Upload `blob` to the cell/file's audio object using R2 multipart upload.
 *
 * Resolves with the same shape as `uploadCellAudio` so callers can treat the
 * two paths interchangeably. On any fatal failure the multipart upload is
 * aborted before the error is rethrown, so no partial parts are left behind.
 */
export async function uploadCellAudioMultipart(
  args: UploadCellAudioMultipartArgs,
): Promise<AudioUploadResult> {
  const {
    projectId, fileId, audioId, ext, blob, artifactId, artifactName, getSyncToken,
  } = args
  if (blob.size === 0) throw new Error("audio upload: file is empty")
  if (blob.size > MAX_AUDIO_OBJECT_BYTES) {
    const gb = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(1)
    throw new Error(
      `This file is ${gb(blob.size)} GB — the limit is ${gb(MAX_AUDIO_OBJECT_BYTES)} GB. `
      + "Split the recording, or compress it first.",
    )
  }

  const fetchFn = args.fetchFn ?? fetch
  const delays = args.retryDelaysMs ?? PART_RETRY_DELAYS_MS
  let token = await getSyncToken(projectId, fileId)
  if (!token) {
    throw new Error("audio upload: no sync token (not signed in or no project access)")
  }

  const throwIfCancelled = () => {
    if (args.signal?.aborted) throw new Error("audio upload cancelled")
  }

  /**
   * One phase request, with retry on transient failures and a single
   * token refresh on 401. Returns the Response; non-retryable failures throw.
   */
  const send = async (
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Response> => {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
      throwIfCancelled()
      let res: Response | null = null
      let networkFailure = false
      try {
        res = await fetchFn(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
          signal: args.signal,
        })
      } catch (error) {
        throwIfCancelled()
        // Network-level failure (the offline window in the acceptance test) —
        // retryable, and the part is re-sent rather than the whole upload.
        networkFailure = true
        lastError = error instanceof Error ? error : new Error(String(error))
      }
      if (res) {
        if (res.ok) return res
        const text = await res.text().catch(() => "")
        lastError = new Error(`${what} failed (${res.status}): ${text || res.statusText}`)
        if (res.status === 401 && attempt < PART_ATTEMPTS - 1) {
          const refreshed = await getSyncToken(projectId, fileId)
          if (refreshed) {
            token = refreshed
            continue
          }
        }
        if (!isRetryableStatus(res.status)) throw lastError
      }
      if (attempt < PART_ATTEMPTS - 1) {
        // The connection dropped rather than the server refusing: wait for it
        // to come back before spending the next attempt on a dead socket.
        if (networkFailure) await waitForOnline(args.signal, MAX_OFFLINE_WAIT_MS)
        throwIfCancelled()
        await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt] ?? 0))
      }
    }
    throw lastError ?? new Error(`${what} failed`)
  }

  // --- 1. create ---
  const createRes = await send(
    multipartEndpoint(projectId, fileId, audioId, ext, { multipart: "create" }),
    {
      method: "POST",
      headers: {
        "X-Upload-Content-Type": blob.type || "application/octet-stream",
        "X-Upload-Total-Bytes": String(blob.size),
      },
    },
    "multipart create",
  )
  const created = (await createRes.json()) as { uploadId?: string; partSizeBytes?: number }
  if (!created.uploadId) throw new Error("multipart create returned no uploadId")
  const uploadId = created.uploadId
  const partSize = Math.max(
    1,
    args.partSizeBytes ?? created.partSizeBytes ?? AUDIO_MULTIPART_PART_BYTES,
  )
  const partCount = Math.ceil(blob.size / partSize)
  // R2 allows at most 10 000 parts. With the advertised part size this is
  // unreachable (2 GB / 16 MB = 128), but a bad override must fail here with a
  // clear message rather than as a rejected part 10 001 half-way through.
  if (partCount > MAX_AUDIO_PARTS) {
    throw new Error(
      `audio upload: ${partCount} parts exceeds the ${MAX_AUDIO_PARTS}-part limit `
      + `(part size ${partSize} bytes is too small for a ${blob.size}-byte file)`,
    )
  }

  const abort = async () => {
    await fetchFn(
      multipartEndpoint(projectId, fileId, audioId, ext, { multipart: "abort", uploadId }),
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => {})
  }

  try {
    // --- 2. parts ---
    const hash = artifactId ? new Sha256Stream() : null
    const parts: { partNumber: number; etag: string }[] = []
    let uploadedBytes = 0
    for (let index = 0; index < partCount; index++) {
      throwIfCancelled()
      const start = index * partSize
      const slice = blob.slice(start, Math.min(start + partSize, blob.size))
      // Hash once per part, before any upload attempt, so a retried part is
      // never folded into the digest twice. The part is only read into memory
      // when a digest is actually needed; otherwise the Blob slice is handed
      // straight to fetch and the browser streams it.
      if (hash) hash.update(new Uint8Array(await slice.arrayBuffer()))
      const partNumber = index + 1
      const res = await send(
        multipartEndpoint(projectId, fileId, audioId, ext, {
          multipart: "part",
          uploadId,
          partNumber: String(partNumber),
        }),
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: slice,
        },
        `multipart part ${partNumber}`,
      )
      const acked = (await res.json()) as { partNumber?: number; etag?: string }
      if (!acked.etag) throw new Error(`multipart part ${partNumber} returned no etag`)
      parts.push({ partNumber: acked.partNumber ?? partNumber, etag: acked.etag })
      uploadedBytes += slice.size
      args.onProgress?.({ uploadedBytes, totalBytes: blob.size, partNumber, partCount })
    }

    // --- 3. complete ---
    await send(
      multipartEndpoint(projectId, fileId, audioId, ext, { multipart: "complete", uploadId }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts,
          sizeBytes: blob.size,
          ...(hash ? { sha256: hash.digestHex() } : {}),
          ...(artifactId ? { artifactId } : {}),
          ...(artifactName ? { artifactName } : {}),
        }),
      },
      "multipart complete",
    )
  } catch (error) {
    await abort()
    throw error
  }

  return {
    audioId,
    ext,
    url: buildFrontierAudioUrl(audioId, ext),
    sizeBytes: blob.size,
  }
}
