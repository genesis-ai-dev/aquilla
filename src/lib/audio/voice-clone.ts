// Voice client: talks to sync-worker's /api/v1/voice/* routes.
//
//   - reference clips (custom-voice training recordings, Inworld design
//     previews) are project-scoped blobs in R2, uploaded/fetched via
//     /api/v1/voice/reference/:projectId/:id
//   - conversion re-voices a source clip (fresh TTS output, or an existing cell
//     recording by id) into a library voice (voice forge RVC), returning a new
//     cell-audio object id the caller attaches like any other audio.
//
// All three reuse the file-scoped sync token (SyncTokenForFile): the reference
// routes accept any of the project's file tokens (project-scoped auth) and the
// convert route is scoped to the (projectId, fileId) the new audio belongs to.

import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { errorFromVoiceConvert } from "./tts-engine-error"
import type { SyncTokenForFile } from "./upload"

/** Stable reference-clip id (object name incl. ext), e.g. "ref-169..-ab12.webm". */
export function buildVoiceReferenceId(ext: string): string {
  const ts = Date.now()
  const rnd = Math.random().toString(36).slice(2, 11)
  return `ref-${ts}-${rnd}.${ext}`
}

function referenceEndpoint(projectId: string, referenceAudioId: string): string {
  return (
    `${syncWorkerHttpOrigin()}/api/v1/voice/reference/` +
    `${encodeURIComponent(projectId)}/${encodeURIComponent(referenceAudioId)}`
  )
}

export interface UploadVoiceReferenceArgs {
  projectId: string
  /** Any file in the project — used only to mint a project-valid sync token. */
  fileId: string
  referenceAudioId: string
  blob: Blob
  getSyncToken: SyncTokenForFile
}

/** Store a reference clip project-scoped in R2. */
export async function uploadVoiceReference(args: UploadVoiceReferenceArgs): Promise<void> {
  const { projectId, fileId, referenceAudioId, blob, getSyncToken } = args
  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("voice reference upload: no sync token")

  const res = await fetch(referenceEndpoint(projectId, referenceAudioId), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`voice reference upload failed (${res.status}): ${text || res.statusText}`)
  }
}

export interface FetchVoiceReferenceArgs {
  projectId: string
  fileId: string
  referenceAudioId: string
  getSyncToken: SyncTokenForFile
}

/** Fetch a reference clip's raw bytes back (for preview playback). */
export async function fetchVoiceReference(args: FetchVoiceReferenceArgs): Promise<Uint8Array> {
  const { projectId, fileId, referenceAudioId, getSyncToken } = args
  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("voice reference fetch: no sync token")

  const res = await fetch(referenceEndpoint(projectId, referenceAudioId), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`voice reference fetch failed (${res.status}): ${text || res.statusText}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

export interface ConvertToLibraryVoiceArgs {
  projectId: string
  /** File the converted audio is attached to (scopes the sync token). */
  fileId: string
  /** The Voice library voice to convert into (voice forge RVC): a character
   *  voice id, or a trained custom voice `c-<hex>`. */
  libraryVoiceId: string
  /** Fresh source audio (e.g. TTS output) to re-voice. */
  source?: Blob
  /** Or an existing cell-audio object id under this file to re-voice. */
  sourceAudioId?: string
  /** The cell the result attaches to. When sent, the worker names the clip
   *  `vc-<voice fingerprint>-audio-<cellId>-…` (see change-voice.ts). */
  cellId?: string
  getSyncToken: SyncTokenForFile
}

export interface ConvertToLibraryVoiceResult {
  audioId: string
  ext: string
  /** frontier-audio://<id>.<ext> — store on the cell attachment. */
  url: string
  bytes: number
}

/**
 * Re-voice `source` (or the recording at `sourceAudioId`) into a library
 * voice's timbre. The worker runs the voice forge, writes the result to R2,
 * and returns the new audio id — caller attaches it like a normal
 * generated-voice clip.
 */
export async function convertToLibraryVoice(
  args: ConvertToLibraryVoiceArgs,
): Promise<ConvertToLibraryVoiceResult> {
  const { projectId, fileId, libraryVoiceId, source, sourceAudioId, cellId, getSyncToken } = args
  if (!source && !sourceAudioId) {
    throw new Error("convertToLibraryVoice: provide a source blob or sourceAudioId")
  }
  if (!libraryVoiceId) throw new Error("convertToLibraryVoice: provide a libraryVoiceId")
  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("voice convert: no sync token")

  const form = new FormData()
  form.append("projectId", projectId)
  form.append("fileId", fileId)
  form.append("libraryVoiceId", libraryVoiceId)
  if (source) form.append("source", source, "source")
  if (sourceAudioId) form.append("sourceAudioId", sourceAudioId)
  if (cellId) form.append("cellId", cellId)

  const res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/convert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errorFromVoiceConvert(res.status, text || res.statusText)
  }
  return (await res.json()) as ConvertToLibraryVoiceResult
}
