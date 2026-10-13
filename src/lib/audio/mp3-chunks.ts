// AQU-1857: cut an MP3 into byte ranges that each decode on their own.
//
// `decodeAudioData` has no streaming form — it decodes whatever buffer you
// hand it, all at once, into one contiguous Float32 PCM allocation. For a
// 100-minute, 95 MB MP3 that allocation is ~2.3 GB at 48 kHz stereo, which
// either crashes the tab or (on Safari/iPad) fails outright.
//
// MPEG audio frames are self-contained and self-describing: a 4-byte header
// gives the version, layer, bitrate and sample rate, from which the frame's
// exact byte length and sample count follow. So the file can be walked
// header-to-header — reading only the headers, never the audio — and cut at
// frame boundaries into ranges of a bounded duration. Each range is a valid
// MPEG stream the browser decodes by itself, so the import can analyse a
// minute at a time and release each minute's PCM before reading the next.
//
// Deliberately header-only: the walk never materialises frame bodies, so
// planning a 95 MB file costs the ~100 window reads below, not 95 MB of
// retained bytes. The sample counts come from the frame headers rather than
// from the decoder's output length, so a decoder that trims or pads a chunk
// edge (encoder delay) cannot make the analysis drift away from real time.

/** One decodable byte range of an MPEG audio stream. */
export interface Mp3Chunk {
  /** Byte offset of the range's first frame, from the start of the file. */
  start: number
  /** Byte offset one past the range's last frame. */
  end: number
  /** Total PCM samples per channel the range decodes to, from frame headers. */
  samples: number
}

/** A planned stream: its ranges plus the geometry they share. */
export interface Mp3ChunkPlan {
  chunks: Mp3Chunk[]
  /** Sample rate declared by the stream's frames. */
  sampleRate: number
  /** Total samples per channel across every chunk. */
  samples: number
  /** Stream duration in ms, derived from the frame headers. */
  durationMs: number
}

/** How much of the file is read at a time while walking frame headers. A
 *  frame is at most ~1.5 KB, so a window this size covers hundreds of them
 *  and a 95 MB file plans in ~100 reads. */
const SCAN_WINDOW_BYTES = 1 << 20

/** How far into the file to hunt for the first frame when the leading bytes
 *  are neither an ID3v2 tag nor a frame header (junk, a stripped tag). */
const MAX_RESYNC_BYTES = 1 << 16

const MPEG_VERSION_1 = 3
const MPEG_VERSION_2 = 2
const MPEG_VERSION_25 = 0

const LAYER_III = 1
const LAYER_II = 2
const LAYER_I = 3

const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  [MPEG_VERSION_1]: [44100, 48000, 32000],
  [MPEG_VERSION_2]: [22050, 24000, 16000],
  [MPEG_VERSION_25]: [11025, 12000, 8000],
}

// kbps by bitrate index (index 0 = "free", 15 = invalid; both rejected).
const BITRATES_V1: Readonly<Record<number, readonly number[]>> = {
  [LAYER_I]: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [LAYER_II]: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [LAYER_III]: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
}
const BITRATES_V2: Readonly<Record<number, readonly number[]>> = {
  [LAYER_I]: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [LAYER_II]: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [LAYER_III]: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

/** One parsed MPEG audio frame header. */
export interface Mp3FrameHeader {
  /** Frame size in bytes, including the 4-byte header and any padding byte. */
  length: number
  /** PCM samples per channel the frame decodes to. */
  samples: number
  sampleRate: number
}

/**
 * Parse the MPEG audio frame header at `at`, or null when those bytes are not
 * a usable header (no sync word, reserved/invalid field, truncated).
 */
export function parseMp3FrameHeader(bytes: Uint8Array, at: number): Mp3FrameHeader | null {
  if (at < 0 || at + 4 > bytes.length) return null
  const b0 = bytes[at]
  const b1 = bytes[at + 1]
  const b2 = bytes[at + 2]
  // 11 sync bits.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null

  const version = (b1 >> 3) & 0x03
  if (version === 1) return null // reserved
  const layer = (b1 >> 1) & 0x03
  if (layer === 0) return null // reserved

  const bitrateIndex = (b2 >> 4) & 0x0f
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null // free / invalid
  const sampleRateIndex = (b2 >> 2) & 0x03
  if (sampleRateIndex === 3) return null // reserved

  const sampleRate = SAMPLE_RATES[version][sampleRateIndex]
  const bitrate =
    (version === MPEG_VERSION_1 ? BITRATES_V1 : BITRATES_V2)[layer][bitrateIndex] * 1000
  const padding = (b2 >> 1) & 0x01

  // Layer I carries 384 samples per frame in 4-byte slots; Layers II/III carry
  // 1152 (576 for the half-rate MPEG2/2.5 Layer III).
  const samples =
    layer === LAYER_I ? 384 : layer === LAYER_II || version === MPEG_VERSION_1 ? 1152 : 576
  const length =
    layer === LAYER_I
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor((samples / 8) * (bitrate / sampleRate)) + padding
  if (length <= 4) return null
  return { length, samples, sampleRate }
}

/**
 * Byte length of the ID3v2 tag at the start of `bytes`, or 0 when there is
 * none. The size is a syncsafe 28-bit integer, and the footer (when the flag
 * is set) adds another 10 bytes.
 */
export function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0 // "ID3"
  const flags = bytes[5]
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
  return 10 + size + ((flags & 0x10) !== 0 ? 10 : 0)
}

/** Reads `[start, end)` of the stream being planned. */
export type ByteRangeReader = (start: number, end: number) => Promise<Uint8Array>

/** Read a slice of a Blob — the production {@link ByteRangeReader}. */
export function blobRangeReader(blob: Blob): ByteRangeReader {
  return async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

/**
 * Walk `size` bytes of an MPEG audio stream and cut it into decodable ranges
 * of at most `chunkMs` each.
 *
 * Returns null when the bytes are not a frame-aligned MPEG stream we can walk
 * (no frame found, or a frame declaring a different sample rate part-way
 * through — neither is something we should guess at). Callers fall back to
 * whatever they do for an unanalysable file.
 *
 * Trailing bytes that are not a frame header (ID3v1, APE, Lyrics3, padding)
 * end the walk rather than failing it; they carry no audio.
 */
export async function planMp3Chunks(
  read: ByteRangeReader,
  size: number,
  chunkMs: number,
): Promise<Mp3ChunkPlan | null> {
  if (size <= 0 || chunkMs <= 0) return null

  const head = await read(0, Math.min(size, SCAN_WINDOW_BYTES))
  let cursor = id3v2Length(head)

  // The first frame decides the stream's geometry, so find it by requiring a
  // header whose declared length lands on another header — a single 0xFF byte
  // inside a tag or junk is otherwise easy to mistake for a frame.
  let first: Mp3FrameHeader | null = null
  const resyncLimit = Math.min(head.length, cursor + MAX_RESYNC_BYTES)
  for (let at = cursor; at + 4 <= resyncLimit; at++) {
    const candidate = parseMp3FrameHeader(head, at)
    if (!candidate) continue
    const next = parseMp3FrameHeader(head, at + candidate.length)
    if (!next || next.sampleRate !== candidate.sampleRate) continue
    first = candidate
    cursor = at
    break
  }
  if (!first) return null

  const { sampleRate } = first
  const chunkTargetSamples = Math.max(1, Math.round((chunkMs / 1000) * sampleRate))

  const chunks: Mp3Chunk[] = []
  let chunkStart = cursor
  let chunkSamples = 0
  let totalSamples = 0

  // Sliding header-only window. `window` holds [windowStart, windowStart +
  // window.length); a frame length can jump the cursor past its end, which
  // simply triggers the next read.
  let window = head
  let windowStart = 0

  for (;;) {
    if (cursor + 4 > size) break
    if (cursor < windowStart || cursor + 4 > windowStart + window.length) {
      windowStart = cursor
      window = await read(windowStart, Math.min(size, windowStart + SCAN_WINDOW_BYTES))
      if (window.length < 4) break
    }
    const frame = parseMp3FrameHeader(window, cursor - windowStart)
    if (!frame) break // trailing tag or padding — no more audio
    if (frame.sampleRate !== sampleRate) return null // mid-stream rate change
    if (cursor + frame.length > size) break // truncated final frame

    cursor += frame.length
    chunkSamples += frame.samples
    totalSamples += frame.samples

    if (chunkSamples >= chunkTargetSamples) {
      chunks.push({ start: chunkStart, end: cursor, samples: chunkSamples })
      chunkStart = cursor
      chunkSamples = 0
    }
  }

  if (chunkSamples > 0) chunks.push({ start: chunkStart, end: cursor, samples: chunkSamples })
  if (chunks.length === 0) return null

  return {
    chunks,
    sampleRate,
    samples: totalSamples,
    durationMs: (totalSamples / sampleRate) * 1000,
  }
}
