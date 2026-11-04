// AQU-1886: bound the ONE whole-clip decode that AQU-1681 left behind.
//
// AQU-1681 stopped a shared recording being decoded once per row: a batch now
// decodes the clip once and cuts each row's window out of the held 16 kHz mono
// PCM (`shared-clip-pcm.ts`). That removed the "N decodes" term of a
// 100-minute import's ~5 GB peak, but the single remaining decode is still
// `decodeAudioData` over the whole file, and that is unbounded in two ways a
// feature-length recording feels:
//
//   • `decodeAudioData` materialises the entire clip as one AudioBuffer, and
//     the caller copies the mono window out of it, so for the length of that
//     copy TWO whole-clip allocations are alive — ~770 MB for 100 minutes at
//     16 kHz, on top of the ~90 MB of source bytes.
//   • Browsers do not all decode an hour-plus in one call. Safari's
//     `decodeAudioData` stops short (measured on episode 101: 35 of its 55
//     minutes), and every row past that point has nothing to transcribe —
//     `sharedClipWindow` can only warn and hand it silence.
//
// MPEG audio frames are independently decodable, and `mp3-chunks.ts` already
// walks the frame headers to cut a stream into ranges of a bounded duration
// (AQU-1857 added that for the import's silence analysis). So a long MP3 is
// decoded a minute at a time straight into the one output buffer: the peak
// transient allocation is a minute of PCM instead of a second whole clip, and
// no decoder is asked to swallow 100 minutes in one call.
//
// Deliberately only for LONG MPEG clips. A clip inside the budget keeps the
// exact whole-file decode it has today, so the transcript of an ordinary
// import cannot move; anything that is not a frame-walkable MPEG stream (an
// opus/webm take, a wav, a video's m4a) falls back to that same decode, as
// does a chunk that fails to decode.

import { bytesRangeReader, planMp3Chunks } from "./mp3-chunks"

/** Rate the PCM comes back at — Whisper's, and what `shared-clip-pcm.ts` holds. */
export const WHISPER_SAMPLE_RATE = 16_000

/**
 * Clips at least this long take the chunked decode. Ten minutes is ~38 MB of
 * 16 kHz mono PCM — comfortably inside what one decode plus its copy can hold
 * — and longer than any import whose section boundaries a person checked by
 * hand, which is what keeps short-file transcripts identical rather than
 * merely equivalent.
 */
export const CHUNKED_DECODE_MIN_MS = 10 * 60_000

/** Audio decoded per step. A minute of 16 kHz PCM is under 4 MB, so the
 *  transient allocation stops depending on the recording's length. */
export const DECODE_CHUNK_MS = 60_000

/** Decode one byte range to 16 kHz mono PCM. */
export type ChunkDecodeFn = (bytes: Uint8Array) => Promise<Float32Array>

export interface SharedClipDecodeDeps {
  /** Decoder for one chunk. Injected by tests; defaults to Web Audio. */
  decodeChunk?: ChunkDecodeFn
  /** @see CHUNKED_DECODE_MIN_MS */
  minChunkedMs?: number
  /** @see DECODE_CHUNK_MS */
  chunkMs?: number
  /** Hand the main thread back between chunks so a long decode cannot block
   *  paint. Injected by tests to keep them synchronous. */
  yieldToEventLoop?: () => Promise<void>
}

/**
 * A shared clip's 16 kHz mono PCM: chunked when the clip is a long MPEG
 * stream, otherwise `decodeWhole` exactly as before.
 *
 * `decodeWhole` is also the fallback for every reason the chunked route can
 * decline — not MPEG, not frame-walkable, short enough not to need it, or a
 * chunk the decoder refused — so this never fails where the whole-file decode
 * would have succeeded.
 */
export async function decodeSharedClipPcm(
  bytes: Uint8Array,
  decodeWhole: (bytes: Uint8Array) => Promise<Float32Array>,
  deps: SharedClipDecodeDeps = {},
): Promise<Float32Array> {
  const chunked = await decodeLongMp3To16kMono(bytes, deps)
  return chunked ?? decodeWhole(bytes)
}

/**
 * Decode a long MPEG stream to 16 kHz mono PCM a chunk at a time, or null when
 * this clip is not one (no frame walk, a mid-stream rate change, or shorter
 * than `minChunkedMs`) or a chunk failed to decode.
 *
 * Each chunk is written at the offset its frame headers put it at, measured
 * from the start of the recording rather than chunk by chunk, so a decoder
 * that drops or adds samples at a chunk edge (encoder delay) cannot
 * accumulate drift across a hundred chunks and slide every later row's window
 * off the audio it names. A chunk that decodes short leaves silence for the
 * samples it owed; one that decodes long is cut to them.
 */
export async function decodeLongMp3To16kMono(
  bytes: Uint8Array,
  deps: SharedClipDecodeDeps = {},
): Promise<Float32Array | null> {
  const chunkMs = deps.chunkMs ?? DECODE_CHUNK_MS
  const minChunkedMs = deps.minChunkedMs ?? CHUNKED_DECODE_MIN_MS
  const plan = await planMp3Chunks(bytesRangeReader(bytes), bytes.byteLength, chunkMs).catch(() => null)
  if (!plan || plan.durationMs < minChunkedMs) return null

  const decodeChunk = deps.decodeChunk ?? webAudioChunkDecoder()
  if (!decodeChunk) return null

  const scale = WHISPER_SAMPLE_RATE / plan.sampleRate
  const out = new Float32Array(Math.round(plan.samples * scale))
  let sourceSamples = 0
  let written = 0

  for (const chunk of plan.chunks) {
    sourceSamples += chunk.samples
    const endSample = Math.min(out.length, Math.round(sourceSamples * scale))
    const owed = endSample - written
    if (owed <= 0) continue

    let pcm: Float32Array
    try {
      pcm = await decodeChunk(bytes.subarray(chunk.start, chunk.end))
    } catch (err) {
      console.warn(
        `[transcribe] AQU-1886: the chunked decode of a shared clip failed ` +
          `${(written / WHISPER_SAMPLE_RATE).toFixed(1)}s in; decoding it whole instead:`,
        err,
      )
      return null
    }
    // `out` is zero-filled, so a short chunk's missing samples are silence.
    out.set(pcm.length > owed ? pcm.subarray(0, owed) : pcm, written)
    written = endSample
    if (deps.yieldToEventLoop) await deps.yieldToEventLoop()
  }

  return written === out.length ? out : out.subarray(0, written)
}

/** The one context every chunk decodes through — see `webAudioChunkDecoder`. */
let offlineDecoder: OfflineAudioContext | null = null

/** @internal — test-only. Drops the held decoding context. */
export function __resetSharedClipDecoderForTests(): void {
  offlineDecoder = null
}

/**
 * The production {@link ChunkDecodeFn}, or null where Web Audio cannot decode
 * (no `OfflineAudioContext` — a worker, a test environment).
 *
 * One context decodes every chunk (AQU-1857 found the same thing for the
 * import's analysis): a page may only create so many audio contexts, and a
 * 100-minute recording is ~100 chunks. `decodeAudioData` resamples into the
 * context's rate for us, so each chunk arrives at 16 kHz already.
 */
function webAudioChunkDecoder(): ChunkDecodeFn | null {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
  if (!Offline) return null
  return async (chunk) => {
    // `decodeAudioData` detaches the buffer it is given, so it gets a copy of
    // the chunk rather than a view onto the clip's bytes.
    const ab = new ArrayBuffer(chunk.byteLength)
    new Uint8Array(ab).set(chunk)
    const ctx = (offlineDecoder ??= new Offline(1, 1, WHISPER_SAMPLE_RATE))
    let buffer: AudioBuffer
    try {
      buffer = await ctx.decodeAudioData(ab)
    } catch (err) {
      // A context-level fault must not poison every later chunk; a genuinely
      // undecodable chunk still surfaces as itself, and the caller then
      // decodes the clip whole.
      offlineDecoder = null
      throw err
    }
    return downmixToMono(buffer)
  }
}

/**
 * A decoded buffer as one mono channel, averaging the channels it has — the
 * same downmix the whole-file path applies, so a stereo clip transcribes from
 * the same signal whichever route decoded it.
 */
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  if (buffer.numberOfChannels === 1) {
    buffer.copyFromChannel(out, 0)
    return out
  }
  // One channel-sized scratch buffer at a time — never the whole
  // multi-channel chunk at once.
  const scratch = new Float32Array(buffer.length)
  const n = buffer.numberOfChannels
  for (let ch = 0; ch < n; ch++) {
    buffer.copyFromChannel(scratch, ch)
    for (let i = 0; i < out.length; i++) out[i] += scratch[i] / n
  }
  return out
}
