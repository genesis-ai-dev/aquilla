// Main-thread orchestrator: audio bytes → 16kHz Float32 PCM → Whisper worker
// → word-level timings. No Y.Doc dependency — timings are written back via the
// D1 event log (cell.audio.attach with timings payload).
//
// Owns a single worker instance per page so the Whisper model stays cached in
// memory after the first run.

import { requestAiModelConsent, WHISPER_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import { alignChunks } from "./timings"
import { setTranscribeStatus } from "./transcribe-status"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { makeAudioSyncTokenFetcher } from "./sync-token-fetcher"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import type {
  ResultMessage,
  ErrorMessage,
  ProgressMessage,
  TranscribeRequest,
} from "./whisper-worker"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

export interface TranscriptionProgress {
  status: string
  file: string
  loaded: number
  total: number
}

export interface TranscriptionResult {
  text: string
  chunks: Array<{ text: string; start: number; end: number }>
}

export interface TranscriptionOptions {
  language?: string
  model?: string
  onProgress?: (p: TranscriptionProgress) => void
}

const WHISPER_SAMPLE_RATE = 16000

const AudioCtxCtor =
  typeof window !== "undefined"
    ? (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    : null

let workerPromise: Promise<Worker> | null = null
let workerSeq = 0

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise
  workerPromise = (async () => {
    const mod = await import("./whisper-worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  })()
  workerPromise.catch(() => { workerPromise = null })
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
 * Run Whisper on the given audio bytes. Returns the transcript text and
 * word-level timing chunks.
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
          status: msg.status,
          file: msg.file,
          loaded: msg.loaded,
          total: msg.total,
        })
        return
      }
      worker.removeEventListener("message", onMessage)
      if (msg.type === "result") resolve(msg)
      else reject(new Error((msg as ErrorMessage).message))
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

  return { text: result.text, chunks: result.chunks }
}

export interface TranscribeCellArgs {
  cell: CellData
  session: FrontierSession | null
  projectId: string
  language?: string
}

/**
 * Transcribe a single cell's selected audio. Drives the per-cell
 * transcribe-status store (so CellTranscribeBadge shows progress), then
 * re-emits a cell.audio.attach with the word-level timings so they land in
 * D1 durably.
 *
 * Returns the word count on success, or 0 if the cell has no audio / consent
 * was denied. Never throws — errors are stored in transcribe-status.
 */
export async function transcribeCell(args: TranscribeCellArgs): Promise<number> {
  const { cell, session, projectId, language } = args
  const audioId = cell.selectedAudioId
  if (!audioId) return 0

  const attachment = cell.attachments?.[audioId]
  const attachmentUrl = attachment?.url
  if (!attachmentUrl) return 0

  const frontier = parseFrontierAudioUrl(attachmentUrl)
  if (!frontier) return 0
  if (!session?.jwt) return 0

  const getSyncToken = makeAudioSyncTokenFetcher(() => session)

  setTranscribeStatus(audioId, { kind: "loading", loaded: 0, total: 0, file: "" })

  const t0 = Date.now()
  try {
    const bytes = await fetchCellAudio({
      projectId,
      fileId: cell.fileId,
      audioId: frontier.audioId,
      ext: frontier.ext,
      getSyncToken,
    })

    setTranscribeStatus(audioId, { kind: "transcribing" })

    const result = await transcribeAudio(bytes, {
      language,
      onProgress: (p) => {
        setTranscribeStatus(audioId, {
          kind: "loading",
          loaded: p.loaded,
          total: p.total,
          file: p.file,
        })
        if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
          setTranscribeStatus(audioId, { kind: "transcribing" })
        }
      },
    })

    const wordCount = result.chunks.length

    // Persist timings durably via D1 event log — re-attach the same audioId
    // with the word-level timing chunks so the projection writer can store
    // them. start/end must be char offsets into the cell's plain text — the
    // karaoke decoration maps them against the TipTap doc, so align against
    // cell.translated (transcript offsets as fallback when counts mismatch).
    if (result.chunks.length > 0) {
      const timings = alignChunks(result.chunks, cell.translated)
      void emitCellAudioAttach({
        projectId,
        fileId: cell.fileId,
        cellId: cell.id,
        audioId,
        url: attachmentUrl,
        slot: "recording",
        timings,
        author: session.username ?? "local",
      })
    }

    setTranscribeStatus(audioId, {
      kind: "done",
      wordCount,
      durationMs: Date.now() - t0,
    })
    return wordCount
  } catch (e) {
    if (e instanceof AiModelConsentDeniedError) {
      setTranscribeStatus(audioId, { kind: "idle" })
      return 0
    }
    setTranscribeStatus(audioId, {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    })
    return 0
  }
}
