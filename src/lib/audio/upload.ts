// R2-backed audio upload for web-only (non-git) projects.
// Uploads a recorded Blob to the frontier-server /api/v2/audio route and
// returns the logical attachment URL to store on the cell.
//
// GitLab-imported projects push audio via LFS instead (not implemented here).

import { FRONTIER_BASE } from "@/lib/frontier/auth"
import type { FrontierSession } from "@/lib/frontier/types"

const AUDIO_URL_SCHEME = "frontier-audio"

export interface AudioUploadResult {
  audioId: string
  ext: string
  /** Logical URL stored on the cell attachment. Scheme-prefixed so readers
   *  know to resolve via the frontier audio worker instead of the repo FS. */
  url: string
  sizeBytes: number
}

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

/** Extract the attachment URL scheme marker. Returns null for legacy (LFS path) urls. */
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

export async function uploadCellAudio(args: {
  session: FrontierSession
  projectId: string
  audioId: string
  ext: string
  blob: Blob
}): Promise<AudioUploadResult> {
  const { session, projectId, audioId, ext, blob } = args
  if (!session.jwt) throw new Error("not signed in")

  const url = `${FRONTIER_BASE}/api/v2/audio/${encodeURIComponent(projectId)}/${encodeURIComponent(audioId)}.${ext}`
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.jwt}`,
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

/**
 * Fetch an uploaded audio blob back from the worker. Used by playback for
 * non-git projects. Returns the raw bytes; the caller wraps them in a Blob
 * for the <audio> element.
 */
export async function fetchCellAudio(args: {
  session: FrontierSession
  projectId: string
  audioId: string
  ext: string
}): Promise<Uint8Array> {
  const { session, projectId, audioId, ext } = args
  if (!session.jwt) throw new Error("not signed in")

  const url = `${FRONTIER_BASE}/api/v2/audio/${encodeURIComponent(projectId)}/${encodeURIComponent(audioId)}.${ext}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.jwt}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`audio fetch failed (${res.status}): ${text || res.statusText}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}
