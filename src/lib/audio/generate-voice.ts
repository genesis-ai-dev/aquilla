// Generate a cell's voice audio and attach it durably.
//
//   synthesize (Gemini/MMS TTS) → if the resolved voice is a clone voice
//   (referenceAudioId set), re-voice the TTS output into that timbre via
//   Seed-VC → upload to R2 → emit cell.audio.attach (generatedVoice slot).
//
// Replaces the ripped synth-and-attach.ts path. Returns the playable blob so
// the caller can play immediately without a second fetch (for clone voices the
// blob is the converted clip, fetched back from R2).

import { synthesizeForCell } from "./tts"
import { resolveVoice } from "./voices"
import { resolveTtsProvider } from "./tts-providers"
import { buildAudioId, uploadCellAudio, fetchCellAudio } from "./upload"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { convertToCloneVoice } from "./voice-clone"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { injectOptimisticAudioAttachment, notifyAudioAttachmentsChanged } from "./audio-attachments-bus"
import { probeDurationMsSafe } from "@/lib/import"
import { synthesizeCellTts } from "@/lib/sync/tts"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { GeminiTtsContext } from "./gemini-tts"
import type { SynthOptions } from "./tts"

export interface GenerateAndAttachArgs {
  projectId: string
  fileId: string
  cellId: string
  text: string
  projectTtsSettings?: ProjectTtsSettings
  cellVoiceId?: string
  geminiContext?: GeminiTtsContext
  session: FrontierSession
  /** Frontier username — author of the cell.audio.attach event. */
  username: string
  /** Round 8c: TTS is a TAKE — its permanent name, set at birth. */
  label?: string
  diffusionSteps?: number
  onProgress?: SynthOptions["onProgress"]
}

export interface GenerateAndAttachResult {
  audioId: string
  /** frontier-audio://<id>.<ext> stored on the attachment. */
  url: string
  /** Playable bytes (converted clip for clone voices, TTS output otherwise). */
  blob: Blob
}

export async function generateAndAttachCellVoice(
  args: GenerateAndAttachArgs,
): Promise<GenerateAndAttachResult> {
  const text = args.text.trim()
  if (!text) throw new Error("Cell has no text to synthesize")

  const voice = resolveVoice(args.projectTtsSettings, args.cellVoiceId)
  // Resolve the effective engine: a voice with no provider falls back to the
  // project default (now OmniVoice), which must still route server-side.
  const provider = voice.provider ?? resolveTtsProvider(args.projectTtsSettings)
  const getSyncToken = audioSyncTokenFetcherForSession(args.session)

  // OmniVoice is server-side: the sync-worker synthesizes, stores the clip in
  // R2 (native voice-cloning when a reference is set), and returns its id —
  // no client synth, no upload, no Seed-VC. Branch out entirely.
  if (provider === "omnivoice") {
    const result = await synthesizeCellTts(
      {
        projectId: args.projectId,
        fileId: args.fileId,
        cellId: args.cellId,
        text,
        ...(args.geminiContext?.targetLanguage ? { language: args.geminiContext.targetLanguage } : {}),
        ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
      },
      getSyncToken,
    )
    await emitCellAudioAttach({
      projectId: args.projectId,
      fileId: args.fileId,
      cellId: args.cellId,
      audioId: result.objectName,
      url: result.url,
      durationMs: Math.round(result.durationSeconds * 1000),
      slot: "generatedVoice",
      mimeType: "audio/wav",
      voiceId: voice.id,
      ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
      ...(args.label ? { label: args.label } : {}),
      author: args.username,
    })
    // Round 8: shadow-inject so the sparkle chip appears at its real length
    // instantly — the notify's refetch would otherwise read pre-flush state.
    injectOptimisticAudioAttachment(args.fileId, args.cellId, {
      audioId: result.objectName,
      url: result.url,
      slot: "generatedVoice",
      mimeType: "audio/wav",
      voiceId: voice.id,
      referenceAudioId: voice.referenceAudioId ?? null,
      durationMs: Math.round(result.durationSeconds * 1000),
      label: args.label ?? null,
      trimStartMs: null,
      trimEndMs: null,
    })
    notifyAudioAttachmentsChanged(args.fileId)
    const bytes = await fetchCellAudio({
      projectId: args.projectId,
      fileId: args.fileId,
      audioId: result.audioId,
      ext: "wav",
      getSyncToken,
    })
    return {
      audioId: result.objectName,
      url: result.url,
      blob: new Blob([bytes as BlobPart], { type: "audio/wav" }),
    }
  }

  // 1. Multilingual TTS.
  const ttsBlob = await synthesizeForCell(text, {
    projectTtsSettings: args.projectTtsSettings,
    cellVoiceId: args.cellVoiceId,
    geminiContext: args.geminiContext,
    onProgress: args.onProgress,
  })

  let audioId: string
  let ext: string
  let url: string
  let playable: Blob

  if (voice.referenceAudioId) {
    // 2a. Clone: re-voice TTS output into the reference timbre. The worker
    // writes the converted wav to R2 and returns its id; fetch it back so we
    // can play the actual cloned audio (not the pre-conversion TTS).
    const conv = await convertToCloneVoice({
      projectId: args.projectId,
      fileId: args.fileId,
      referenceAudioId: voice.referenceAudioId,
      source: ttsBlob,
      diffusionSteps: args.diffusionSteps,
      getSyncToken,
    })
    audioId = conv.audioId
    ext = conv.ext
    url = conv.url
    const bytes = await fetchCellAudio({
      projectId: args.projectId,
      fileId: args.fileId,
      audioId: conv.audioId,
      ext: conv.ext,
      getSyncToken,
    })
    playable = new Blob([bytes as BlobPart], { type: "audio/wav" })
  } else {
    // 2b. Plain TTS: upload the blob as-is.
    const baseId = buildAudioId(args.cellId)
    ext = "wav"
    const res = await uploadCellAudio({
      projectId: args.projectId,
      fileId: args.fileId,
      audioId: baseId,
      ext,
      blob: ttsBlob,
      getSyncToken,
    })
    audioId = res.audioId
    url = res.url
    playable = ttsBlob
  }

  // 3. Attach durably (generatedVoice slot). The bus poke surfaces it via the
  // per-file read; the WS broadcast does the same for collaborators.
  // Round 6: probe the clip's duration so its Target-track chip renders at
  // the generated audio's real length (best-effort).
  const objectName = `${audioId}.${ext}`
  const generatedDurationMs = await probeDurationMsSafe(playable)
  await emitCellAudioAttach({
    projectId: args.projectId,
    fileId: args.fileId,
    cellId: args.cellId,
    audioId: objectName,
    url,
    slot: "generatedVoice",
    mimeType: "audio/wav",
    voiceId: voice.id,
    ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
    ...(generatedDurationMs != null ? { durationMs: generatedDurationMs } : {}),
    ...(args.label ? { label: args.label } : {}),
    author: args.username,
  })
  // Round 8: shadow-inject (see the omnivoice branch's comment).
  injectOptimisticAudioAttachment(args.fileId, args.cellId, {
    audioId: objectName,
    url,
    slot: "generatedVoice",
    mimeType: "audio/wav",
    voiceId: voice.id,
    referenceAudioId: voice.referenceAudioId ?? null,
    durationMs: generatedDurationMs ?? null,
    label: args.label ?? null,
    trimStartMs: null,
    trimEndMs: null,
  })
  notifyAudioAttachmentsChanged(args.fileId)

  return { audioId: objectName, url, blob: playable }
}
