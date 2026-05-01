// Generate AI audio for a cell: synthesize text via the configured TTS
// provider, upload as a WAV attachment, then run Whisper to populate karaoke
// timings.

import * as Y from "yjs"
import { synthesizeForCell, synthesizeToWavBlob } from "./tts"
import { buildAudioId, uploadCellAudio } from "./upload"
import { attachAudioToCell } from "./attach"
import { transcribeAndStoreTimings, transcribeAudio } from "./transcribe"
import { whisperLanguageFromTag } from "./language"
import { setTranscribeStatus } from "./transcribe-status"
import { tokenizeWords, writeCellTimings } from "./timings"
import { floatPcmToWavBlob } from "./wav"
import { resolveVoice } from "./voices"
import { resolveApiKey } from "@/lib/store/user-api-keys"
import { markProjectHasAudioDataSoon } from "./project-audio-state"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { WordTiming } from "@/lib/codex-editor/types"

export interface SynthAndAttachArgs {
  doc: Y.Doc
  cellId: string
  cellText: string
  cellOriginal?: string
  cellContext?: string
  cellLabel?: string
  projectId: string
  sourceLanguage?: string
  /** Project language tag — passed to Whisper so the auto-transcription
   *  step uses the right decoder rather than auto-detecting from a few
   *  seconds of synthesized speech. */
  languageTag?: string
  session: FrontierSession
  username: string
  speed?: number
  projectTtsSettings?: ProjectTtsSettings
  /** Voice id picked for this cell. Falls back to the project default. */
  cellVoiceId?: string
  onTtsProgress?: (p: { loaded: number; total: number; file: string; status: string }) => void
}

export interface SynthGroupCellInput {
  id: string
  text: string
  original?: string
  context?: string
  cellLabel?: string
}

export interface SynthAndAttachGroupArgs {
  doc: Y.Doc
  cells: SynthGroupCellInput[]
  projectId: string
  sourceLanguage?: string
  languageTag?: string
  session: FrontierSession
  username: string
  speed?: number
  projectTtsSettings?: ProjectTtsSettings
  /** Voice id used for the entire take. */
  voiceId?: string
  onTtsProgress?: (p: { loaded: number; total: number; file: string; status: string }) => void
  onTranscribeProgress?: (p: { loaded: number; total: number; file: string; status: string }) => void
}

export async function synthAndAttachAudio(args: SynthAndAttachArgs): Promise<{ audioId: string; blob: Blob }> {
  const text = args.cellText.trim()
  if (!text) throw new Error("Cell has no text to synthesize")

  const blob = await synthesizeForCell(text, {
    projectTtsSettings: args.projectTtsSettings,
    cellVoiceId: args.cellVoiceId,
    speed: args.speed,
    geminiContext: {
      sourceLanguage: args.sourceLanguage,
      targetLanguage: args.languageTag,
      original: args.cellOriginal,
      context: args.cellContext,
      cellLabel: args.cellLabel,
    },
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
    slot: "generatedVoice",
  })
  markProjectHasAudioDataSoon(args.projectId)

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

  return { audioId: result.audioId, blob }
}

export async function synthAndAttachAudioGroup(
  args: SynthAndAttachGroupArgs,
): Promise<{ audioIds: Map<string, string>; blob: Blob; clips: Array<{ cellId: string; audioId: string; blob: Blob }> }> {
  const cells = args.cells
    .map((cell) => ({ ...cell, text: cell.text.trim() }))
    .filter((cell) => cell.text.length > 0)
  if (cells.length === 0) throw new Error("No cells have text to synthesize")
  if (cells.length === 1) {
    const cell = cells[0]
    const result = await synthAndAttachAudio({
      doc: args.doc,
      cellId: cell.id,
      cellText: cell.text,
      cellOriginal: cell.original,
      cellContext: cell.context,
      cellLabel: cell.cellLabel,
      projectId: args.projectId,
      sourceLanguage: args.sourceLanguage,
      languageTag: args.languageTag,
      session: args.session,
      username: args.username,
      speed: args.speed,
      projectTtsSettings: args.projectTtsSettings,
      cellVoiceId: args.voiceId,
      onTtsProgress: args.onTtsProgress,
    })
    return {
      audioIds: new Map([[cell.id, result.audioId]]),
      blob: result.blob,
      clips: [{ cellId: cell.id, audioId: result.audioId, blob: result.blob }],
    }
  }

  const voice = resolveVoice(args.projectTtsSettings, args.voiceId)
  const combinedText = cells.map((cell) => cell.text).join("\n\n")
  const combinedOriginal = cells.map((cell) => cell.original?.trim()).filter(Boolean).join("\n\n")
  const combinedContext = cells.map((cell) => cell.context?.trim()).filter(Boolean).join("\n\n")
  const combinedLabels = cells.map((cell) => cell.cellLabel?.trim()).filter(Boolean).join(", ")

  const blob = await synthesizeToWavBlob(combinedText, {
    voice,
    projectProvider: args.projectTtsSettings?.provider,
    apiKey: resolveApiKey("gemini-tts", args.projectTtsSettings?.apiKey),
    speed: args.speed,
    geminiContext: {
      sourceLanguage: args.sourceLanguage,
      targetLanguage: args.languageTag,
      original: combinedOriginal,
      context: combinedContext,
      cellLabel: combinedLabels,
    },
    onProgress: args.onTtsProgress,
  })

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const transcription = await transcribeAudio(bytes, {
    cellText: combinedText,
    language: whisperLanguageFromTag(args.languageTag),
    onProgress: args.onTranscribeProgress,
  })
  const combinedWords = tokenizeWords(combinedText)
  if (!timingsAreAlignedToText(transcription.timings, combinedWords)) {
    throw new Error("Generated take could not be aligned back to cells. Try a shorter take or generate cells individually.")
  }

  const decoded = await decodeAudioBlob(blob)
  const segments = buildCellSegments(cells, transcription.timings)
  const audioIds = new Map<string, string>()
  const clips: Array<{ cellId: string; audioId: string; blob: Blob }> = []

  for (const segment of segments) {
    const clipBlob = audioBufferSegmentToWavBlob(decoded, segment.clipStart, segment.clipEnd)
    const audioId = buildAudioId(segment.cell.id)
    const result = await uploadCellAudio({
      session: args.session,
      projectId: args.projectId,
      audioId,
      ext: "wav",
      blob: clipBlob,
    })
    attachAudioToCell(args.doc, segment.cell.id, {
      audioId: result.audioId,
      url: result.url,
      username: args.username,
      mimeType: "audio/wav",
      slot: "generatedVoice",
    })
    markProjectHasAudioDataSoon(args.projectId)
    writeCellTimings(args.doc, segment.cell.id, result.audioId, segment.timings)
    audioIds.set(segment.cell.id, result.audioId)
    clips.push({ cellId: segment.cell.id, audioId: result.audioId, blob: clipBlob })
  }

  return { audioIds, blob, clips }
}

function timingsAreAlignedToText(
  timings: WordTiming[],
  words: Array<{ word: string; start: number; end: number }>,
): boolean {
  return timings.length === words.length && timings.every((timing, index) => {
    const word = words[index]
    return timing.start === word.start && timing.end === word.end
  })
}

function buildCellSegments(
  cells: Array<SynthGroupCellInput & { text: string }>,
  timings: WordTiming[],
): Array<{
  cell: SynthGroupCellInput & { text: string }
  clipStart: number
  clipEnd: number
  timings: WordTiming[]
}> {
  const out: Array<{
    cell: SynthGroupCellInput & { text: string }
    clipStart: number
    clipEnd: number
    timings: WordTiming[]
  }> = []
  let cursor = 0
  for (const cell of cells) {
    const words = tokenizeWords(cell.text)
    const slice = timings.slice(cursor, cursor + words.length)
    cursor += words.length
    if (slice.length === 0) continue

    const clipStart = Math.max(0, slice[0].t0 - 0.05)
    const clipEnd = slice[slice.length - 1].t1 + 0.12
    out.push({
      cell,
      clipStart,
      clipEnd,
      timings: slice.map((timing, index) => ({
        word: words[index]?.word ?? timing.word,
        start: words[index]?.start ?? timing.start,
        end: words[index]?.end ?? timing.end,
        t0: Math.max(0, timing.t0 - clipStart),
        t1: Math.max(0, timing.t1 - clipStart),
      })),
    })
  }
  return out
}

async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const AudioCtxCtor =
    typeof window !== "undefined"
      ? (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
      : null
  if (!AudioCtxCtor) throw new Error("Web Audio API unavailable")

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const ctx = new AudioCtxCtor()
  try {
    return await ctx.decodeAudioData(copy.buffer as ArrayBuffer)
  } finally {
    void ctx.close()
  }
}

function audioBufferSegmentToWavBlob(buffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const sampleRate = buffer.sampleRate
  const start = Math.max(0, Math.floor(startSec * sampleRate))
  const end = Math.min(buffer.length, Math.max(start + 1, Math.ceil(endSec * sampleRate)))
  const pcm = new Float32Array(end - start)

  if (buffer.numberOfChannels <= 1) {
    pcm.set(buffer.getChannelData(0).subarray(start, end))
  } else {
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel)
      for (let i = start; i < end; i++) {
        pcm[i - start] += data[i] / buffer.numberOfChannels
      }
    }
  }

  return floatPcmToWavBlob(pcm, sampleRate)
}
