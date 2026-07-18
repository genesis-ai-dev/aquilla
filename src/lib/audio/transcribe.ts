// Main-thread orchestrator: audio bytes → 16kHz Float32 PCM → Whisper worker
// → word-level timings. No Y.Doc dependency — timings are written back via the
// D1 event log (cell.audio.attach with timings payload).
//
// Owns a single worker instance per page so the Whisper model stays cached in
// memory after the first run.

import { requestAiModelConsent, WHISPER_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import { alignChunks } from "./timings"
import { noteModelDownloading, noteModelDownloadSettled } from "./prefetch"
import { setTranscribeStatus } from "./transcribe-status"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { audioCacheGet, audioCachePut } from "./bytes-cache"
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

  // The first transcribe on a cold cache downloads the Whisper weights inside
  // this worker. Feed that progress into the shared model-status store so the
  // bottom-left AiModelDownloadChip lights up — same surface the onboarding
  // prefetch uses — instead of the download being invisible outside this cell.
  let sawDownload = false
  let settled = false

  try {
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
          if (msg.total > 0) {
            sawDownload = true
            noteModelDownloading("whisper", { loaded: msg.loaded, total: msg.total, file: msg.file })
          }
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

    if (sawDownload) { noteModelDownloadSettled("whisper", true); settled = true }
    return { text: result.text, chunks: result.chunks }
  } catch (e) {
    if (sawDownload && !settled) noteModelDownloadSettled("whisper", false)
    throw e
  }
}

export interface TranscribeCellArgs {
  cell: CellData
  session: FrontierSession | null
  projectId: string
  language?: string
}

// Test seam: transcribeCell calls transcribeAudio through this binding so
// unit tests can stub out the Whisper worker (which is dynamically imported).
// Mirrors the __setRootForTests precedent in bytes-cache.ts.
let transcribeAudioImpl: typeof transcribeAudio = transcribeAudio

/** @internal — test-only. Pass null to restore the real implementation. */
export function __setTranscribeAudioForTests(fn: typeof transcribeAudio | null): void {
  transcribeAudioImpl = fn ?? transcribeAudio
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

  // Early guards write an error status instead of returning silently — the
  // Recording tab renders these via CellTranscribeBadge, and a bare `return 0`
  // left the user with a button that did nothing and no explanation.
  const attachment = cell.attachments?.[audioId]
  const attachmentUrl = attachment?.url
  if (!attachmentUrl) {
    setTranscribeStatus(audioId, { kind: "error", message: "This recording has no downloadable audio yet. Try again after it finishes syncing." })
    return 0
  }

  const frontier = parseFrontierAudioUrl(attachmentUrl)
  if (!frontier) {
    setTranscribeStatus(audioId, { kind: "error", message: "This audio isn't stored in a transcribable location." })
    return 0
  }

  // Local-first (FRO-355): a just-recorded take's bytes live in the OPFS cache
  // even before — or without — a successful R2 upload, so transcription can run
  // offline and while signed out. Only the network fallback needs a JWT, so the
  // sign-in guard moves below the cache probe.
  const cached = await audioCacheGet(frontier.audioId, frontier.ext)
  if (!cached && !session?.jwt) {
    setTranscribeStatus(audioId, { kind: "error", message: "Sign in to transcribe audio." })
    return 0
  }

  setTranscribeStatus(audioId, { kind: "loading", loaded: 0, total: 0, file: "" })

  const t0 = Date.now()
  try {
    let bytes = cached
    if (!bytes) {
      const getSyncToken = makeAudioSyncTokenFetcher(() => session)
      bytes = await fetchCellAudio({
        projectId,
        fileId: cell.fileId,
        audioId: frontier.audioId,
        ext: frontier.ext,
        getSyncToken,
      })
      // Write through so a later transcribe/play hits the cache (mirrors
      // useCellAudio.ensureBytes). Non-fatal if OPFS is unavailable.
      void audioCachePut(frontier.audioId, frontier.ext, bytes)
    }

    setTranscribeStatus(audioId, { kind: "transcribing" })

    const result = await transcribeAudioImpl(bytes, {
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
      // Signed-out transcribes (cache hit) have no session — the emit queues
      // to the local outbox and can throw a role-gate error, so swallow it:
      // transcription itself succeeded, and the timings re-emit on a manual
      // re-transcribe. author falls back to "local".
      void emitCellAudioAttach({
        projectId,
        fileId: cell.fileId,
        cellId: cell.id,
        audioId,
        url: attachmentUrl,
        slot: "recording",
        timings,
        author: session?.username ?? "local",
      }).catch((err) => {
        console.warn("[transcribe] emitCellAudioAttach failed (timings not persisted):", err)
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
