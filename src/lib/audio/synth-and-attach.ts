// Generate AI audio for a cell: synthesize text via Kokoro, upload as a WAV
// attachment, then run Whisper to populate karaoke timings. End-to-end the
// flow lasts a few seconds (mostly model warm-up on first call); subsequent
// cells skip the model load and finish in ~2-3s.

import * as Y from "yjs"
import { synthesizeToWavBlob } from "./tts"
import { buildAudioId, uploadCellAudio } from "./upload"
import { attachAudioToCell } from "./attach"
import { transcribeAndStoreTimings } from "./transcribe"
import { whisperLanguageFromTag } from "./language"
import { setTranscribeStatus } from "./transcribe-status"
import type { FrontierSession } from "@/lib/frontier/types"

export interface SynthAndAttachArgs {
  doc: Y.Doc
  cellId: string
  cellText: string
  projectId: string
  /** Project language tag — passed to Whisper so the auto-transcription
   *  step uses the right decoder rather than auto-detecting from a few
   *  seconds of synthesized speech. */
  languageTag?: string
  session: FrontierSession
  username: string
  voice?: string
  speed?: number
  onTtsProgress?: (p: { loaded: number; total: number; file: string; status: string }) => void
}

export async function synthAndAttachAudio(args: SynthAndAttachArgs): Promise<{ audioId: string }> {
  const text = args.cellText.trim()
  if (!text) throw new Error("Cell has no text to synthesize")

  const blob = await synthesizeToWavBlob(text, {
    voice: args.voice,
    speed: args.speed,
    onProgress: args.onTtsProgress,
  })

  const audioId = buildAudioId(args.cellId)
  const result = await uploadCellAudio({
    session: args.session,
    projectId: args.projectId,
    audioId,
    ext: "wav",
    blob,
  })

  attachAudioToCell(args.doc, args.cellId, {
    audioId: result.audioId,
    url: result.url,
    username: args.username,
    mimeType: "audio/wav",
  })

  // Auto-transcribe so karaoke lights up immediately. Errors here are
  // non-fatal — the audio is already attached and playable.
  void (async () => {
    setTranscribeStatus(result.audioId, { kind: "loading", loaded: 0, total: 0, file: "" })
    const startedAt = Date.now()
    try {
      const audioBytes = new Uint8Array(await blob.arrayBuffer())
      const out = await transcribeAndStoreTimings(args.doc, args.cellId, result.audioId, audioBytes, {
        cellText: text,
        language: whisperLanguageFromTag(args.languageTag),
        onProgress: (p) => {
          setTranscribeStatus(result.audioId, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
          if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
            setTranscribeStatus(result.audioId, { kind: "transcribing" })
          }
        },
      })
      setTranscribeStatus(result.audioId, {
        kind: "done", wordCount: out.timings.length, durationMs: Date.now() - startedAt,
      })
    } catch (e) {
      setTranscribeStatus(result.audioId, {
        kind: "error", message: e instanceof Error ? e.message : String(e),
      })
    }
  })()

  return { audioId: result.audioId }
}
