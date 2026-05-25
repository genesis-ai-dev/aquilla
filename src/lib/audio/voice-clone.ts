// Voice-clone client: talks to sync-worker's /api/v1/voice/* routes.
//
//   - reference clips (the timbre a clone Voice points at) are project-scoped
//     blobs in R2, uploaded/fetched via /api/v1/voice/reference/:projectId/:id
//   - conversion re-voices a source clip (fresh TTS output, or an existing cell
//     recording by id) into a reference clip's timbre via Seed-VC, returning a
//     new cell-audio object id the caller attaches like any other audio.
//
// All three reuse the file-scoped sync token (SyncTokenForFile): the reference
// routes accept any of the project's file tokens (project-scoped auth) and the
// convert route is scoped to the (projectId, fileId) the new audio belongs to.

import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
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

export interface ConvertToCloneVoiceArgs {
  projectId: string
  /** File the converted audio is attached to (scopes the sync token). */
  fileId: string
  /** Reference clip id whose timbre to convert into. */
  referenceAudioId: string
  /** Fresh source audio (e.g. TTS output) to re-voice. */
  source?: Blob
  /** Or an existing cell-audio object id under this file to re-voice. */
  sourceAudioId?: string
  /** Seed-VC diffusion steps (4-10 fast, 25 default, 30-50 best). */
  diffusionSteps?: number
  getSyncToken: SyncTokenForFile
}

export interface ConvertToCloneVoiceResult {
  audioId: string
  ext: string
  /** frontier-audio://<id>.<ext> — store on the cell attachment. */
  url: string
  bytes: number
}

/**
 * Re-voice `source` (or the recording at `sourceAudioId`) into the reference
 * clip's timbre. The worker calls Seed-VC, writes the result to R2, and returns
 * the new audio id — caller attaches it like a normal generated-voice clip.
 */
export async function convertToCloneVoice(
  args: ConvertToCloneVoiceArgs,
): Promise<ConvertToCloneVoiceResult> {
  const { projectId, fileId, referenceAudioId, source, sourceAudioId, diffusionSteps, getSyncToken } = args
  if (!source && !sourceAudioId) {
    throw new Error("convertToCloneVoice: provide a source blob or sourceAudioId")
  }
  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("voice convert: no sync token")

  const form = new FormData()
  form.append("projectId", projectId)
  form.append("fileId", fileId)
  form.append("referenceAudioId", referenceAudioId)
  if (source) form.append("source", source, "source")
  if (sourceAudioId) form.append("sourceAudioId", sourceAudioId)
  if (typeof diffusionSteps === "number") form.append("diffusionSteps", String(diffusionSteps))

  const res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/convert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`voice convert failed (${res.status}): ${text || res.statusText}`)
  }
  return (await res.json()) as ConvertToCloneVoiceResult
}
