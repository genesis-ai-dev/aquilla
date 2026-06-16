// Orchestrates "remove noise from a take": fetch the source clip, run RNNoise
// on-device, and attach the cleaned result as a NEW take (auto-selected). The
// original is never mutated — it stays in the takes strip. The cleaned take
// records its source via `referenceAudioId`, which the UI uses to revert.
//
// Mirrors the recording-modal save flow (upload → cell.audio.attach → optimistic
// inject + bus poke) so the cleaned take surfaces immediately, even if the WS is
// momentarily down.

import type { FrontierSession } from "@/lib/frontier/types"
import {
  buildDenoisedAudioId,
  uploadCellAudio,
  deleteCellAudio,
  fetchCellAudio,
  parseFrontierAudioUrl,
} from "./upload"
import { decodeToMono48k } from "./decode-mono"
import { denoiseMono48k } from "./denoise"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  notifyAudioAttachmentsChanged,
} from "./audio-attachments-bus"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "./project-audio-state"
import { setTranscribeStatus } from "./transcribe-status"

function extForMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg"
  if (mimeType.includes("webm")) return "webm"
  return "webm"
}

export interface DenoiseTakeArgs {
  projectId: string
  fileId: string
  cellId: string
  /** Stored id of the take to clean, e.g. "audio-cell12-…-xyz.webm". */
  sourceAudioId: string
  /** frontier-audio:// url of the source take. */
  sourceUrl: string
  author: string
  session: FrontierSession | null
}

export interface DenoiseTakeResult {
  /** Stored id of the new cleaned take ("dn-…<.ext>"). */
  audioId: string
  url: string
  durationMs: number
}

export async function denoiseTake(args: DenoiseTakeArgs): Promise<DenoiseTakeResult> {
  const { projectId, fileId, cellId, sourceAudioId, sourceUrl, author, session } = args
  if (!session?.jwt) throw new Error("Sign in to remove noise")

  const source = parseFrontierAudioUrl(sourceUrl)
  if (!source) throw new Error("This take can't be denoised (unsupported audio source)")
  const getSyncToken = audioSyncTokenFetcherForSession(session)

  // 1. Fetch + decode the source clip to mono 48 kHz.
  const bytes = await fetchCellAudio({
    projectId,
    fileId,
    audioId: source.audioId,
    ext: source.ext,
    getSyncToken,
  })
  const samples = await decodeToMono48k(bytes)

  // 2. Run RNNoise → WebM/Opus blob.
  const { blob, durationMs, mimeType } = await denoiseMono48k(samples)

  // 3. Upload as a new (denoised) take.
  const ext = extForMime(mimeType)
  const newId = buildDenoisedAudioId(cellId)
  const result = await uploadCellAudio({ projectId, fileId, audioId: newId, ext, blob, getSyncToken })
  const fullAudioId = `${result.audioId}.${result.ext}`

  setTranscribeStatus(result.audioId, { kind: "idle" })
  markProjectHasAudioDataSoon(projectId)

  // 4. Attach (records + selects the clip in its slot). Link back to the source
  //    take so the UI can revert. On emit failure, clean up the orphaned R2
  //    object and re-throw the original error.
  try {
    await emitCellAudioAttach({
      projectId,
      fileId,
      cellId,
      audioId: fullAudioId,
      url: result.url,
      slot: "recording",
      mimeType: blob.type || undefined,
      referenceAudioId: sourceAudioId,
      durationMs: Math.round(durationMs),
      author,
    })
  } catch (emitErr) {
    void deleteCellAudio({ projectId, fileId, audioId: result.audioId, ext: result.ext, getSyncToken })
    throw emitErr
  }

  // 5. Optimistically surface the cleaned take so it shows without waiting for
  //    the outbox flush + projection round-trip.
  injectOptimisticAudioAttachment(fileId, cellId, {
    audioId: fullAudioId,
    url: result.url,
    slot: "recording",
    mimeType: blob.type || null,
    voiceId: null,
    referenceAudioId: sourceAudioId,
    durationMs: Math.round(durationMs),
    trimStartMs: null,
    trimEndMs: null,
  })
  notifyAudioAttachmentsChanged(fileId)

  return { audioId: fullAudioId, url: result.url, durationMs }
}
