// Main-thread orchestrator that ties recorded audio bytes → 16kHz Float32
// PCM → Whisper worker → cell.audioTimings on the Y.Doc. Owns a single
// worker instance per page so the Whisper model stays cached in memory after
// the first run.

import * as Y from "yjs"
import type { WordTiming } from "@/lib/codex-editor/types"
import { writeCellTimings, tokenizeWords } from "./timings"
import { requestAiModelConsent, WHISPER_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import type {
  ResultMessage,
  ErrorMessage,
  ProgressMessage,
  TranscribeRequest,
} from "./whisper-worker"

export interface TranscriptionProgress {
  status: string
  file: string
  loaded: number
  total: number
}

export interface TranscriptionResult {
  text: string
  chunks: Array<{ text: string; start: number; end: number }>
  timings: WordTiming[]
}

export interface TranscriptionOptions {
  language?: string
  model?: string
  onProgress?: (p: TranscriptionProgress) => void
  /** Existing cell text. If provided and word-aligned with the transcript,
   *  timings use cell-text offsets so karaoke matches what the user typed. */
  cellText?: string
}

const AudioCtxCtor =
  typeof window !== "undefined"
    ? (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    : null

const WHISPER_SAMPLE_RATE = 16000

let workerPromise: Promise<Worker> | null = null
let workerSeq = 0

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise
  workerPromise = (async () => {
    // Dynamic import lets Vite emit the worker as a separate chunk; the main
    // bundle never pulls in transformers.js until transcription is requested.
    const mod = await import("./whisper-worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  })()
  return workerPromise
}

export async function audioBytesToWhisperPcm(bytes: Uint8Array): Promise<Float32Array> {
  if (!AudioCtxCtor) throw new Error("Web Audio API unavailable")
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)

  const ctx = new AudioCtxCtor()
  let buffer: AudioBuffer
  try {
    buffer = await ctx.decodeAudioData(copy.buffer as ArrayBuffer)
  } finally {
    void ctx.close()
  }

  if (buffer.sampleRate === WHISPER_SAMPLE_RATE && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice(0)
  }

  const targetLen = Math.ceil(buffer.duration * WHISPER_SAMPLE_RATE)
  const offline = new OfflineAudioContext(1, targetLen, WHISPER_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice(0)
}

/**
 * Run Whisper on the given audio bytes. Returns chunks plus a WordTiming[]
 * indexed against either cell text (preferred when alignable) or the
 * transcript itself.
 */
export async function transcribeAudio(
  bytes: Uint8Array,
  opts: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
  const consented = await requestAiModelConsent(WHISPER_MODEL)
  if (!consented) throw new AiModelConsentDeniedError(WHISPER_MODEL.id)
  const pcm = await audioBytesToWhisperPcm(bytes)
  const worker = await getWorker()
  const requestId = `t-${++workerSeq}`

  const result = await new Promise<ResultMessage>((resolve, reject) => {
    const onMessage = (event: MessageEvent<ResultMessage | ErrorMessage | ProgressMessage>) => {
      const msg = event.data
      if (msg.requestId !== requestId) return
      if (msg.type === "progress") {
        opts.onProgress?.({
          status: msg.status, file: msg.file, loaded: msg.loaded, total: msg.total,
        })
        return
      }
      worker.removeEventListener("message", onMessage)
      if (msg.type === "result") resolve(msg)
      else reject(new Error(msg.message))
    }
    worker.addEventListener("message", onMessage)
    const req: TranscribeRequest = {
      type: "transcribe",
      requestId,
      pcm,
      sampleRate: WHISPER_SAMPLE_RATE,
      language: opts.language,
      model: opts.model,
    }
    worker.postMessage(req)
  })

  const timings = alignChunks(result.chunks, opts.cellText)
  return { text: result.text, chunks: result.chunks, timings }
}

/**
 * Convert Whisper chunks → WordTiming[]. When `cellText` is provided and the
 * chunks line up 1:1 with the cell's tokenized words, we emit timings indexed
 * against the cell text so the karaoke decoration paints the user's typed
 * words. Otherwise we index against the transcript itself (won't match cell
 * text, but the user can re-record to fix).
 */
export function alignChunks(
  chunks: Array<{ text: string; start: number; end: number }>,
  cellText: string | undefined,
): WordTiming[] {
  if (chunks.length === 0) return []

  if (cellText) {
    const cellWords = tokenizeWords(cellText)
    if (cellWords.length === chunks.length) {
      return cellWords.map((w, i) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        t0: chunks[i].start,
        t1: chunks[i].end,
      }))
    }
  }

  // Fall back to indexing against the transcript text.
  const transcript = chunks.map((c) => c.text).join(" ")
  const transcriptWords = tokenizeWords(transcript)
  const out: WordTiming[] = []
  for (let i = 0; i < Math.min(transcriptWords.length, chunks.length); i++) {
    out.push({
      word: transcriptWords[i].word,
      start: transcriptWords[i].start,
      end: transcriptWords[i].end,
      t0: chunks[i].start,
      t1: chunks[i].end,
    })
  }
  return out
}

/**
 * High-level helper used by the recording flow: transcribe audio and persist
 * timings to the cell. Resolves once the timings are written.
 */
export async function transcribeAndStoreTimings(
  doc: Y.Doc,
  cellId: string,
  audioId: string,
  bytes: Uint8Array,
  opts: TranscriptionOptions & { cellText?: string } = {},
): Promise<TranscriptionResult> {
  const result = await transcribeAudio(bytes, opts)
  if (result.timings.length > 0) {
    writeCellTimings(doc, cellId, audioId, result.timings)
  }
  return result
}
