// "Voice together": synthesize several selected cells as ONE continuous TTS
// clip (better prosody than gluing separate takes), then let the user mark
// where each line falls inside that clip with a manual divider editor.
//
// How it works:
//   1. Join the selected cells' target text (document order) with a pause
//      separator and synthesize ONE clip in a single TTS call.
//   2. Upload the clip once to R2 (one object, audioId.ext — keys aren't
//      cell-scoped, so one object can back many cells).
//   3. Attach that same audioId/url to every selected cell (generatedVoice),
//      with NO trim yet — each cell initially plays the whole clip.
//   4. The caller opens CombinedBoundaryEditor so the user drags dividers to
//      set each cell's [start,end] slice; those persist as trim (localStorage
//      + a server re-attach) via the same path crop uses.
//
// Boundary detection is deliberately MANUAL (no silence/ASR guessing) — the
// editor is the source of truth. Automatic detection can be layered on later
// as a "suggest splits" assist.

import { synthesizeForCell, setTtsStatus, ttsStatusKey } from "./tts"
import { resolveCastVoice } from "./voices"
import { resolveTtsProvider } from "./tts-providers"
import { buildAudioId, uploadCellAudio, fetchCellAudio } from "./upload"
import { uploadLosslessSiblingBestEffort } from "./lossless-sibling"
import { canEncodeOpus, encodeMonoToWebmOpus } from "./opus-encode"
import { decodeToMono48k, TARGET_RATE } from "./decode-mono"
import { audioCachePutBlob } from "./bytes-cache"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { convertToCloneVoice } from "./voice-clone"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged } from "./audio-attachments-bus"
import { synthesizeCellTts } from "@/lib/sync/tts"
import { effectiveSourceText } from "@/lib/cell-text"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

/** Keep the joined request a single, sane TTS call. */
export const MAX_COMBINED_CELLS = 12
export const MAX_COMBINED_CHARS = 2000

/** Pause-inducing separator between cells in the joined text. */
const SEPARATOR = "\n\n"

export interface CombinedVoiceArgs {
  project: ProjectRecord
  fileId: string
  /** Selected cells, already in document order. */
  cells: CellData[]
  settings?: ProjectTtsSettings
  session: FrontierSession | null
  username: string
  onProgress?: (msg: string) => void
}

export interface CombinedVoiceResult {
  /** Shared clip object name (audioId.ext) attached to every chosen cell. */
  audioId: string
  /** frontier-audio:// url of the shared clip. */
  url: string
  /** Voice the clip was synthesized with (for trim re-attach metadata). */
  voiceId: string
  referenceAudioId?: string
  /** The cells that were actually voiced, in document order (post-cap). */
  cells: CellData[]
  /** True if the selection was capped (too many cells / too much text). */
  truncated: boolean
}

/**
 * Synthesize the selected cells as one clip and attach it (untrimmed) to each.
 * Returns the shared clip + the chosen cells so the caller can open the manual
 * boundary editor. Does NOT set any per-cell trim — that's the editor's job.
 */
export async function generateCombinedVoice(args: CombinedVoiceArgs): Promise<CombinedVoiceResult> {
  const { project, fileId, settings, session, username, onProgress } = args
  if (!session?.jwt) throw new Error("Sign in to generate audio")

  // Selectable cells in document order: translated, non-paratext.
  const ordered = args.cells.filter((c) => c.type !== "paratext" && c.translated?.trim())
  if (ordered.length < 2) throw new Error("Select at least two translated lines to voice together")

  // Cap to one sane request (by cell count and total chars).
  const chosen: CellData[] = []
  let chars = 0
  let truncated = false
  for (const c of ordered) {
    const t = c.translated.trim()
    if (chosen.length >= MAX_COMBINED_CELLS || (chosen.length > 0 && chars + t.length > MAX_COMBINED_CHARS)) {
      truncated = true
      break
    }
    chosen.push(c)
    chars += t.length
  }
  if (chosen.length < 2) throw new Error("Selected lines are too long to voice together")

  const statusKeys = chosen.map((c) => ttsStatusKey(c.id))
  const setAll = (s: Parameters<typeof setTtsStatus>[1]) => { for (const k of statusKeys) setTtsStatus(k, s) }

  const voice = resolveCastVoice(settings, chosen[0].id)
  const provider = voice.provider ?? resolveTtsProvider(settings)
  const joined = chosen.map((c) => c.translated.trim()).join(SEPARATOR)
  const getSyncToken = audioSyncTokenFetcherForSession(session)

  setAll({ kind: "synthesizing" })
  try {
    let audioId: string
    let ext: string
    let url: string
    // Server-side branches (omnivoice, clone) return WAV; the client-synth
    // branch overrides when it compresses.
    let combinedMime = "audio/wav"

    if (provider === "omnivoice") {
      // Server-side: one OmniVoice call for the whole joined clip; the worker
      // stores it (native clone when a reference is set) and returns its id.
      onProgress?.("Synthesizing combined clip…")
      const result = await synthesizeCellTts(
        {
          projectId: project.id,
          fileId,
          cellId: chosen[0].id,
          text: joined,
          ...(project.targetLanguage ? { language: project.targetLanguage } : {}),
          ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
        },
        getSyncToken,
      )
      audioId = result.audioId
      ext = "wav"
      url = result.url
    } else {
      onProgress?.("Synthesizing combined clip…")
      const ttsBlob = await synthesizeForCell(joined, {
        projectTtsSettings: settings,
        cellVoiceId: voice.id,
        geminiContext: {
          sourceLanguage: project.sourceLanguage,
          targetLanguage: project.targetLanguage,
          original: effectiveSourceText(chosen[0]),
          context: chosen[0].context,
          cellLabel: chosen[0].cellLabel,
        },
        onProgress: (p) => setAll(
          p.status === "ready" || (p.total > 0 && p.loaded >= p.total)
            ? { kind: "synthesizing" }
            : { kind: "loading", loaded: p.loaded, total: p.total, file: p.file },
        ),
      })

      if (voice.referenceAudioId) {
        onProgress?.("Applying voice clone…")
        const conv = await convertToCloneVoice({
          projectId: project.id,
          fileId,
          referenceAudioId: voice.referenceAudioId,
          source: ttsBlob,
          getSyncToken,
        })
        audioId = conv.audioId
        ext = conv.ext
        url = conv.url
        await fetchCellAudio({ projectId: project.id, fileId, audioId: conv.audioId, ext: conv.ext, getSyncToken })
      } else {
        // FORTIFY: combined "voice together" clips are the LARGEST client-
        // synth generations in the app (up to 12 cells of prosody in one
        // file) and were still uploading raw WAV after the compression round
        // shipped — the exact block generate-voice.ts uses, same fallback.
        const baseId = buildAudioId(chosen[0].id)
        let uploadBlob = ttsBlob
        ext = "wav"
        combinedMime = "audio/wav"
        if (canEncodeOpus()) {
          try {
            const samples = await decodeToMono48k(new Uint8Array(await ttsBlob.arrayBuffer()))
            const encoded = await encodeMonoToWebmOpus(samples, TARGET_RATE)
            uploadBlob = encoded.blob
            combinedMime = encoded.mimeType
            ext = encoded.ext
          } catch (e) {
            console.warn("[combined-voice] opus compress failed; uploading WAV", e)
          }
        }
        const res = await uploadCellAudio({ projectId: project.id, fileId, audioId: baseId, ext, blob: uploadBlob, getSyncToken })
        audioId = res.audioId
        url = res.url
        // Local-first: the exact playable bytes are in hand — stock the byte
        // cache so first playback/peaks/transcription need no re-download.
        void audioCachePutBlob(res.audioId, ext, uploadBlob)
        // Meeting note (2026-08-05): keep the original WAV obtainable — same
        // base id, ext "wav", unattached, best-effort (see lossless-sibling).
        if (ext === "webm") {
          void uploadLosslessSiblingBestEffort({
            projectId: project.id,
            fileId,
            audioId: baseId,
            wavBlob: ttsBlob,
            getSyncToken,
          })
        }
      }
    }
    const objectName = `${audioId}.${ext}`

    // Attach the shared clip to every cell (untrimmed). The boundary editor
    // sets each cell's slice afterward.
    for (const c of chosen) {
      await emitCellAudioAttach({
        projectId: project.id,
        fileId,
        cellId: c.id,
        audioId: objectName,
        url,
        slot: "generatedVoice",
        mimeType: combinedMime,
        voiceId: voice.id,
        ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
        author: username,
      })
    }
    notifyAudioAttachmentsChanged(fileId)
    setAll({ kind: "idle" })
    return {
      audioId: objectName,
      url,
      voiceId: voice.id,
      ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
      cells: chosen,
      truncated,
    }
  } catch (e) {
    setAll({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
