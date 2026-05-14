// Per-cell audio storage backed by sync-worker's R2 bucket.
//
// Audio rides on the same R2 lifecycle as snapshots/tails — admin DELETE
// of a file wipes its audio subdirectory automatically, and per-PR sandbox
// workers stay isolated via R2_KEY_PREFIX without any extra plumbing here.
//
// URL scheme stored on cell attachments stays `frontier-audio://<id>.<ext>`
// for backwards compatibility with existing recordings.

import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

const AUDIO_URL_SCHEME = "frontier-audio"

export interface AudioUploadResult {
  audioId: string
  ext: string
  /** Logical URL stored on the cell attachment. The scheme prefix tells
   *  readers to resolve via the sync-worker rather than treating it as
   *  a path inside a repo working copy. */
  url: string
  sizeBytes: number
}

export type SyncTokenForFile = (
  projectId: string,
  fileId: string,
) => Promise<string | null>

/**
 * Build a stable audio id in the desktop format:
 *   audio-{cellId}-{timestamp}-{random}
 * Characters in cellId that R2 object names dislike (":" etc.) are normalised.
 */
export function buildAudioId(cellId: string): string {
  const normalised = cellId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
  const ts = Date.now()
  const rnd = Math.random().toString(36).slice(2, 11)
  return `audio-${normalised}-${ts}-${rnd}`
}

/** Extract the (audioId, ext) marker. Returns null for legacy LFS-pointer paths. */
export function parseFrontierAudioUrl(url: string): { audioId: string; ext: string } | null {
  const prefix = `${AUDIO_URL_SCHEME}://`
  if (!url.startsWith(prefix)) return null
  const raw = url.slice(prefix.length)
  const dot = raw.lastIndexOf(".")
  if (dot <= 0 || dot === raw.length - 1) return null
  return { audioId: raw.slice(0, dot), ext: raw.slice(dot + 1) }
}

export function buildFrontierAudioUrl(audioId: string, ext: string): string {
  return `${AUDIO_URL_SCHEME}://${audioId}.${ext}`
}

function audioEndpoint(projectId: string, fileId: string, audioId: string, ext: string): string {
  const objectName = `${audioId}.${ext}`
  return (
    `${syncWorkerHttpOrigin()}/audio/` +
    `${encodeURIComponent(projectId)}/` +
    `${encodeURIComponent(fileId)}/` +
    `${encodeURIComponent(objectName)}`
  )
}

export interface UploadCellAudioArgs {
  projectId: string
  fileId: string
  audioId: string
  ext: string
  blob: Blob
  getSyncToken: SyncTokenForFile
}

export async function uploadCellAudio(args: UploadCellAudioArgs): Promise<AudioUploadResult> {
  const { projectId, fileId, audioId, ext, blob, getSyncToken } = args
  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("audio upload: no sync token (not signed in or no project access)")

  const res = await fetch(audioEndpoint(projectId, fileId, audioId, ext), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`audio upload failed (${res.status}): ${text || res.statusText}`)
  }
  return {
    audioId,
    ext,
    url: buildFrontierAudioUrl(audioId, ext),
    sizeBytes: blob.size,
  }
}

export interface FetchCellAudioArgs {
  projectId: string
  fileId: string
  audioId: string
  ext: string
  getSyncToken: SyncTokenForFile
}

/** Fetch an uploaded audio blob back from sync-worker. Returns the raw
 *  bytes; the caller wraps them in a Blob for the <audio> element. */
export async function fetchCellAudio(args: FetchCellAudioArgs): Promise<Uint8Array> {
  const { projectId, fileId, audioId, ext, getSyncToken } = args
  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("audio fetch: no sync token (not signed in or no project access)")

  const res = await fetch(audioEndpoint(projectId, fileId, audioId, ext), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`audio fetch failed (${res.status}): ${text || res.statusText}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}
