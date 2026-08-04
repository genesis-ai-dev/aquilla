// Main-thread orchestrator: audio bytes → 16kHz Float32 PCM → Whisper worker
// → word-level timings. No Y.Doc dependency — timings are written back via the
// D1 event log (cell.audio.attach with timings payload).
//
// Owns a single worker instance per page so the Whisper model stays cached in
// memory after the first run.

import { requestAiModelConsent, WHISPER_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import { alignChunks } from "./timings"
import { whisperLanguageFromTag } from "./language"
import { noteModelDownloading, noteModelDownloadSettled } from "./prefetch"
import { setTranscribeStatus } from "./transcribe-status"
import { fetchCellAudio, parseFrontierAudioUrl, audioIdSeededWith } from "./upload"
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
  /** AQU-646: transcribe only this window of the clip (shared imported clip →
   *  per-cell segment). Absent = whole clip (recorded takes). */
  trim?: PcmTrimWindow
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

/** AQU-646: a trim window (ms) selecting one segment of a shared clip. */
export interface PcmTrimWindow {
  trimStartMs?: number | null
  trimEndMs?: number | null
}

/**
 * AQU-646: slice a 16 kHz mono PCM buffer to a trim window. Exported for
 * tests. Out-of-range/absent edges clamp to the clip bounds; an inverted or
 * empty window returns the full clip (defensive — better a long transcript
 * than none).
 */
export function slicePcmToTrim(pcm: Float32Array, trim?: PcmTrimWindow): Float32Array {
  const startMs = trim?.trimStartMs ?? null
  const endMs = trim?.trimEndMs ?? null
  if (startMs == null && endMs == null) return pcm
  const start = Math.max(0, Math.min(pcm.length, Math.round(((startMs ?? 0) / 1000) * WHISPER_SAMPLE_RATE)))
  const end = endMs == null
    ? pcm.length
    : Math.max(0, Math.min(pcm.length, Math.round((endMs / 1000) * WHISPER_SAMPLE_RATE)))
  if (end <= start) return pcm
  return pcm.slice(start, end)
}

export async function audioBytesToWhisperPcm(bytes: Uint8Array, trim?: PcmTrimWindow): Promise<Float32Array> {
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
    return slicePcmToTrim(buffer.getChannelData(0).slice(0), trim)
  }

  const targetLen = Math.ceil(buffer.duration * WHISPER_SAMPLE_RATE)
  const offline = new OfflineAudioContext(1, targetLen, WHISPER_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return slicePcmToTrim(rendered.getChannelData(0).slice(0), trim)
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
  const pcm = await audioBytesToWhisperPcm(bytes, opts.trim)
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

    // AQU-646: imported media segments share one clip — transcribe only this
    // cell's trim window. Recorded takes have no trims (whole clip). And route
    // the language through the Whisper tag mapper (raw project language names
    // were being fed to transformers.js verbatim; unmapped → auto-detect).
    //
    // SUB-29: "media segment" must mean the SOURCE CLIP is selected — a user
    // can record a take onto a media cell (dubbing), and that take is target
    // speech: whole-clip transcription, timings against the translation, and
    // it must NEVER write the section's source transcription. Provenance
    // comes from the audioId seed (source clip = fileId, takes = cellId).
    const isMediaCell = cell.medium === "media"
    const isSourceSegment = isMediaCell && !audioIdSeededWith(audioId, cell.id)
    const trim = isSourceSegment
      ? { trimStartMs: attachment?.trimStartMs ?? null, trimEndMs: attachment?.trimEndMs ?? null }
      : undefined

    const result = await transcribeAudioImpl(bytes, {
      language: whisperLanguageFromTag(language) ?? undefined,
      trim,
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
    const transcriptText = result.text.trim()
    if (result.chunks.length > 0 || (isSourceSegment && transcriptText)) {
      // AQU-646: for SOURCE segments align timings against the transcript itself
      // (there's no target text yet — the transcript IS the text karaoke maps);
      // takes (incl. dub takes on media cells) align against the translation.
      const timings = alignChunks(result.chunks, isSourceSegment ? transcriptText : cell.translated)
      // Signed-out transcribes (cache hit) have no session — the emit queues
      // to the local outbox and can throw a role-gate error, so swallow it:
      // transcription itself succeeded, and the timings re-emit on a manual
      // re-transcribe. author falls back to "local".
      //
      // AQU-783: AWAIT the attach so the event is durably in the outbox before
      // transcribeCell resolves. The per-cell / timeline / batch completion
      // handlers flush the outbox and revalidate the cell the moment this
      // promise settles; a fire-and-forget emit let that flush race ahead of
      // the IDB write, so the transcript only surfaced after a manual refresh.
      await emitCellAudioAttach({
        projectId,
        fileId: cell.fileId,
        cellId: cell.id,
        audioId,
        url: attachmentUrl,
        // SUB-49: a generated-voice clip must not be relocated into the
        // recording slot by transcribing it (the upsert assigns `slot`
        // outright, and the sibling-deselect above it would drop the real
        // take). Follow the clip's own slot.
        slot: audioId === cell.selectedGeneratedVoiceAudioId ? "generatedVoice" : "recording",
        timings,
        // Preserve attachment fields the projection UPSERT would otherwise
        // null out — belt and braces now that the projection COALESCEs them
        // too (SUB-49). The trim window is load-bearing for imported segments
        // (it defines the cell's slice of the shared clip).
        ...(attachment?.trimStartMs != null ? { trimStartMs: attachment.trimStartMs } : {}),
        ...(attachment?.trimEndMs != null ? { trimEndMs: attachment.trimEndMs } : {}),
        ...(attachment?.durationMs != null ? { durationMs: attachment.durationMs } : {}),
        ...(attachment?.voiceId ? { voiceId: attachment.voiceId } : {}),
        ...(attachment?.referenceAudioId ? { referenceAudioId: attachment.referenceAudioId } : {}),
        // AQU-646/SUB-29: only the SOURCE segment carries the transcript — the
        // server lands it on the cell's `transcription` (translatable source
        // text). Takes are target audio and must not write source text; the
        // guard is attachment PROVENANCE, not cell medium, so a dub take
        // recorded onto a media section can never clobber its transcript.
        ...(isSourceSegment && transcriptText ? { transcription: transcriptText } : {}),
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
