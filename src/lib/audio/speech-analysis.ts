// AQU-1857: decide HOW an imported recording gets analysed for silences,
// so that length alone can no longer crash the tab.
//
// The silence splitter needs one RMS value per 20 ms window, but
// `decodeAudioData` only hands back whole-file PCM: a 100-minute, 95 MB MP3
// becomes a single ~2.3 GB Float32 allocation at 48 kHz stereo. Chrome climbs
// to several GB and freezes; Safari/iPad fails the allocation outright.
//
// So the decode is sized to the file:
//
//   • Within the PCM budget — the overwhelming majority of imports — decode
//     the whole file exactly as before, on a realtime context at the
//     platform's own rate. Short files must import identically, so this path
//     is left byte-for-byte alone.
//   • Over budget and frame-walkable (MPEG audio) — decode a minute at a time
//     at the analysis rate, folding each chunk into the RMS envelope and
//     releasing its PCM before reading the next. Peak PCM is one chunk.
//   • Over budget, not frame-walkable, but small enough at the analysis rate —
//     decode whole at that reduced rate.
//   • Otherwise — no analysis. The importer's existing fallback applies: one
//     whole-file segment, with the real probed duration. Strictly better than
//     a crashed tab, and the user can still split by hand.
//
// Only the first path can run on a file short enough for a human to have
// checked boundaries by hand, which is what keeps the "segments match the
// current method on a short file" guarantee exact rather than approximate.

import { t } from "../i18n/standalone"
import {
  createRmsEnvelope,
  detectSpeechSegments,
  detectSpeechSegmentsFromEnvelope,
  DEFAULT_WINDOW_MS,
  type SpeechSegment,
} from "../timeline/silence-split"
import { blobRangeReader, planMp3Chunks, type Mp3ChunkPlan } from "./mp3-chunks"

/** Sample rate the chunked/reduced analysis decodes at. Silence detection is
 *  a broadband energy measurement, so it does not need musical bandwidth —
 *  16 kHz keeps every speech formant that matters at a third of 48 kHz's
 *  memory, and is comfortably inside every browser's OfflineAudioContext
 *  range. */
export const ANALYSIS_SAMPLE_RATE = 16_000

/** Ceiling on the decoded PCM a single decode may allocate. 384 MB is about
 *  16 minutes of 48 kHz stereo — long enough that normal imports keep the
 *  untouched whole-file path, small enough that the allocation itself is not
 *  the thing that kills the tab. */
export const PCM_BUDGET_BYTES = 384 * 1024 * 1024

/** Audio the chunked path decodes per step. One minute of 16 kHz stereo is
 *  under 8 MB of PCM, so peak memory stops depending on recording length. */
export const ANALYSIS_CHUNK_MS = 60_000

/** Worst-case bytes per second of decoded PCM at `sampleRate`: Float32, and
 *  stereo, because `decodeAudioData` keeps the source's channel count. */
const PCM_BYTES_PER_SECOND_PER_RATE = 4 * 2

/** Source bytes we are willing to decode whole when the duration probe failed
 *  and we therefore cannot estimate the PCM at all. */
const UNKNOWN_DURATION_SOURCE_LIMIT_BYTES = 16 * 1024 * 1024

/** A frame-walked plan is only trusted when it accounts for essentially the
 *  whole recording — a short plan means the walk stopped early, and analysing
 *  a truncated stream would silently lose the tail. */
const MIN_PLAN_COVERAGE = 0.9

/** Channel 0 of a decode, plus the geometry the analysis needs. */
export interface DecodedPcm {
  channel: Float32Array
  sampleRate: number
  durationMs: number
}

/**
 * Decode `bytes` to PCM. `sampleRate`, when given, asks for the decode to be
 * resampled to that rate (the browser does it for us by decoding into a
 * context created at that rate); omitting it means the platform's own rate.
 */
export type AudioDecodeFn = (bytes: ArrayBuffer, sampleRate?: number) => Promise<DecodedPcm>

export interface SpeechAnalysis {
  /** Detected speech ranges — empty when the file could not be analysed, which
   *  the importer already treats as "one whole-file segment". */
  segments: SpeechSegment[]
  durationMs: number | undefined
}

/** The size thresholds that choose a route. Overridable so a test can drive
 *  each route without a multi-gigabyte fixture; production always uses the
 *  constants above. */
export interface SpeechAnalysisLimits {
  /** @see PCM_BUDGET_BYTES */
  pcmBudgetBytes: number
  /** @see ANALYSIS_CHUNK_MS */
  chunkMs: number
  /** @see UNKNOWN_DURATION_SOURCE_LIMIT_BYTES */
  unknownDurationSourceLimitBytes: number
}

const DEFAULT_LIMITS: SpeechAnalysisLimits = {
  pcmBudgetBytes: PCM_BUDGET_BYTES,
  chunkMs: ANALYSIS_CHUNK_MS,
  unknownDurationSourceLimitBytes: UNKNOWN_DURATION_SOURCE_LIMIT_BYTES,
}

export interface SpeechAnalysisDeps {
  /** Decoder to use. Defaults to Web Audio; injected by tests. */
  decode?: AudioDecodeFn
  limits?: Partial<SpeechAnalysisLimits>
  /** Cheap metadata-only duration probe. Returns undefined when unavailable —
   *  the caller owns this because the importer already has one. */
  probeDurationMs?: (blob: Blob) => Promise<number | undefined>
  /** Hand the main thread back between chunks so a long import cannot block
   *  paint. Injected by tests to keep them synchronous. */
  yieldToEventLoop?: () => Promise<void>
}

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  )
}

function offlineContextCtor(): typeof OfflineAudioContext | undefined {
  if (typeof window === "undefined") return undefined
  return (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
}

function toDecodedPcm(audio: AudioBuffer): DecodedPcm {
  return {
    channel: audio.getChannelData(0),
    sampleRate: audio.sampleRate,
    durationMs: audio.duration * 1000,
  }
}

/**
 * Web Audio decode. Without a requested rate this is the realtime context the
 * importer has always used, at the platform's own rate — the whole-file path
 * must not change. With one, it decodes offline at that rate: an
 * OfflineAudioContext never reconfigures the shared audio device (AQU-1217)
 * and does not count against the page's context cap, which matters when the
 * chunked path opens one per minute of audio.
 */
async function decodeWithWebAudio(bytes: ArrayBuffer, sampleRate?: number): Promise<DecodedPcm> {
  if (sampleRate !== undefined) {
    const decoded = await decodeOffline(bytes, sampleRate)
    if (decoded) return decoded
  }
  const AC = audioContextCtor()
  if (!AC) throw new Error("Web Audio API is unavailable in this environment")
  const ctx = sampleRate !== undefined ? new AC({ sampleRate }) : new AC()
  try {
    return toDecodedPcm(await ctx.decodeAudioData(bytes))
  } finally {
    void ctx.close?.()
  }
}

/**
 * One OfflineAudioContext per analysis rate, reused for every chunk.
 *
 * `decodeAudioData` does not depend on a context's rendering state, so a
 * single context can decode any number of buffers. The chunked path used to
 * build a fresh one per chunk — about 100 of them for a 100-minute recording,
 * each owning its decoded AudioBuffer until the collector got to it. The QA
 * walk on PR #1357 measured a 791 MB peak renderer RSS where the live chunk
 * PCM is bounded at ~8 MB, and 100 uncollected 60-second buffers at 16 kHz
 * stereo is 768 MB — that pile-up, not the chunking, was the remaining cost.
 */
const offlineDecoders = new Map<number, OfflineAudioContext>()

/**
 * Decode at `sampleRate` on the shared offline context, or null when this
 * platform has no OfflineAudioContext (the caller falls back to a realtime
 * one).
 *
 * A context is cached only once it has decoded something, and is dropped again
 * if it ever rejects — so a browser that dislikes reuse poisons one chunk, not
 * every later import. This chunk's rejection still propagates: the caller
 * (`analyseMp3Chunks`) abandons the chunked route and the file falls back to
 * one of the whole-file routes.
 */
async function decodeOffline(bytes: ArrayBuffer, sampleRate: number): Promise<DecodedPcm | null> {
  const Offline = offlineContextCtor()
  if (!Offline) return null
  const existing = offlineDecoders.get(sampleRate)
  if (existing) {
    try {
      return toDecodedPcm(await existing.decodeAudioData(bytes))
    } catch (err) {
      // `decodeAudioData` detaches its input, so the retry below would be
      // handed an empty buffer. Only a context-level fault is recoverable
      // here; a genuinely undecodable chunk must surface as itself.
      offlineDecoders.delete(sampleRate)
      throw err
    }
  }
  const ctx = new Offline(1, 1, sampleRate)
  const decoded = toDecodedPcm(await ctx.decodeAudioData(bytes))
  offlineDecoders.set(sampleRate, ctx)
  return decoded
}

/** True when this platform can decode audio at all. */
function canDecode(): boolean {
  return audioContextCtor() !== undefined || offlineContextCtor() !== undefined
}

/** Worst-case decoded PCM bytes for `durationMs` at `sampleRate`. */
export function estimateDecodedBytes(durationMs: number, sampleRate: number): number {
  return (durationMs / 1000) * sampleRate * PCM_BYTES_PER_SECOND_PER_RATE
}

/** Rate the platform's whole-file decode is assumed to land on when sizing the
 *  budget. Real contexts are 44.1 or 48 kHz; assume the larger. */
const ASSUMED_NATIVE_RATE = 48_000

function looksLikeMpegAudio(file: { name?: string; type?: string }): boolean {
  const type = (file.type ?? "").toLowerCase()
  if (type === "audio/mpeg" || type === "audio/mp3" || type === "audio/mpeg3") return true
  if (type && type !== "application/octet-stream" && type.startsWith("audio/")) return false
  return /\.mp[23]$/i.test(file.name ?? "")
}

/**
 * Analyse an imported media file for speech segments without letting its
 * length decide whether the tab survives.
 *
 * Returns null when the platform cannot decode audio at all (no Web Audio, an
 * undecodable container such as most video) — the importer then falls back to
 * a single whole-file segment, exactly as before. A file that decodes but is
 * too large to analyse comes back with `segments: []` and its real duration,
 * which that same fallback already handles.
 */
export async function analyseSpeechInFile(
  file: File,
  deps: SpeechAnalysisDeps = {},
): Promise<SpeechAnalysis | null> {
  const decode = deps.decode ?? (canDecode() ? decodeWithWebAudio : undefined)
  if (!decode) return null

  const limits = { ...DEFAULT_LIMITS, ...deps.limits }
  const probedMs = deps.probeDurationMs ? await deps.probeDurationMs(file).catch(() => undefined) : undefined

  if (fitsWholeFileBudget(file, probedMs, limits)) {
    const pcm = await decodeWholeFile(file, decode)
    return { segments: detectSpeechSegments(pcm.channel, pcm.sampleRate), durationMs: pcm.durationMs }
  }

  if (looksLikeMpegAudio(file)) {
    const plan = await planMp3Chunks(blobRangeReader(file), file.size, limits.chunkMs).catch(() => null)
    if (plan && coversRecording(plan, probedMs)) {
      const streamed = await analyseMp3Chunks(file, plan, decode, deps.yieldToEventLoop)
      if (streamed) return streamed
    }
  }

  if (probedMs !== undefined && estimateDecodedBytes(probedMs, ANALYSIS_SAMPLE_RATE) <= limits.pcmBudgetBytes) {
    const pcm = await decodeWholeFile(file, decode, ANALYSIS_SAMPLE_RATE)
    return { segments: detectSpeechSegments(pcm.channel, pcm.sampleRate), durationMs: pcm.durationMs }
  }

  // Too long to analyse within budget by any route we have. One whole-file
  // segment with the real duration beats a crashed tab.
  console.warn(
    `[import] AQU-1857: ${file.name} is too long to analyse for silences within the PCM budget; importing as a single segment`,
  )
  return { segments: [], durationMs: probedMs }
}

/** Whether the untouched whole-file decode is safe for this file. */
function fitsWholeFileBudget(
  file: File,
  probedMs: number | undefined,
  limits: SpeechAnalysisLimits,
): boolean {
  if (probedMs === undefined) return file.size <= limits.unknownDurationSourceLimitBytes
  return estimateDecodedBytes(probedMs, ASSUMED_NATIVE_RATE) <= limits.pcmBudgetBytes
}

/** Whether a frame walk accounted for essentially the whole recording. */
function coversRecording(plan: Mp3ChunkPlan, probedMs: number | undefined): boolean {
  if (probedMs === undefined || probedMs <= 0) return true
  return plan.durationMs >= probedMs * MIN_PLAN_COVERAGE
}

async function decodeWholeFile(
  file: File,
  decode: AudioDecodeFn,
  sampleRate?: number,
): Promise<DecodedPcm> {
  const bytes = await file.arrayBuffer()
  // `decodeAudioData` rejects with a cryptic DOMException ("EncodingError:
  // Decoding failed") — rewrap so anything that surfaces or logs the message
  // is user-actionable. The original error is preserved as `cause`.
  return decode(bytes, sampleRate).catch((err: unknown) => {
    throw new Error(t("importExport.errors.couldNotDecodeAudio", { fileName: file.name }), { cause: err })
  })
}

/**
 * Fold a frame-walked MPEG stream into one RMS envelope, a chunk at a time.
 *
 * Each chunk is trimmed or zero-padded to the sample count its frame headers
 * declare, so a decoder that drops or adds samples at a chunk edge (encoder
 * delay) cannot accumulate drift across a hundred chunks and slide every
 * later boundary off real time.
 *
 * Returns null when a chunk fails to decode — the caller then tries its
 * remaining routes rather than reporting a half-analysed recording.
 */
export async function analyseMp3Chunks(
  file: File,
  plan: Mp3ChunkPlan,
  decode: AudioDecodeFn,
  yieldToEventLoop?: () => Promise<void>,
): Promise<SpeechAnalysis | null> {
  const envelope = createRmsEnvelope(ANALYSIS_SAMPLE_RATE, DEFAULT_WINDOW_MS)
  const scale = ANALYSIS_SAMPLE_RATE / plan.sampleRate

  for (const chunk of plan.chunks) {
    let pcm: DecodedPcm
    try {
      const bytes = await file.slice(chunk.start, chunk.end).arrayBuffer()
      pcm = await decode(bytes, ANALYSIS_SAMPLE_RATE)
    } catch (err) {
      console.warn("[import] AQU-1857: chunked silence analysis failed; falling back:", err)
      return null
    }
    const expected = Math.round(chunk.samples * scale)
    envelope.push(
      pcm.channel.length >= expected
        ? pcm.channel.subarray(0, expected)
        : padTo(pcm.channel, expected),
    )
    if (yieldToEventLoop) await yieldToEventLoop()
  }

  return {
    segments: detectSpeechSegmentsFromEnvelope(envelope.finish()),
    durationMs: plan.durationMs,
  }
}

function padTo(samples: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length)
  out.set(samples)
  return out
}
