// AQU-2664 (Sam, Nov 19): measure one section of a recording too long to
// decode whole — a sermon, an episode's sound — within the memory budget.
// The MP3 is cut at frame boundaries (AQU-1857's header-only walk,
// mp3-chunks.ts), and only the chunks that overlap the section are decoded.
// Each chunk is held to the sample count its frame headers declare, so a
// decoder that trims or pads a chunk edge can't shift the section.

import { bytesRangeReader, planMp3Chunks } from "./mp3-chunks"
import { decodeToMono48k, TARGET_RATE } from "./decode-mono"

export interface Mp3WindowOptions {
  /** One chunk's bytes → mono PCM at 48 kHz. */
  decode?: (bytes: Uint8Array) => Promise<Float32Array>
  /** How long a chunk is. */
  chunkSec?: number
}

/** The section [startSec, endSec) as mono PCM at 48 kHz; null when the bytes
 *  aren't an MP3 stream that can be walked. */
export async function decodeMp3Window(bytes: Uint8Array, startSec: number, endSec: number, opts: Mp3WindowOptions = {}): Promise<Float32Array | null> {
  const decode = opts.decode ?? decodeToMono48k
  const plan = await planMp3Chunks(bytesRangeReader(bytes), bytes.length, (opts.chunkSec ?? 30) * 1000)
  if (!plan) return null
  const from = Math.max(0, Math.round(startSec * TARGET_RATE))
  const to = Math.max(from, Math.round(endSec * TARGET_RATE))
  const out = new Float32Array(to - from)
  let at = 0 // the chunk's first sample, at 48 kHz
  for (const chunk of plan.chunks) {
    const len = Math.round((chunk.samples * TARGET_RATE) / plan.sampleRate)
    const end = at + len
    if (end > from && at < to) {
      const pcm = await decode(bytes.subarray(chunk.start, chunk.end))
      const a = Math.max(from, at)
      const b = Math.min(to, end)
      const piece = pcm.subarray(a - at, Math.min(pcm.length, b - at))
      out.set(piece, a - from)
    }
    if (end >= to) break
    at = end
  }
  return out
}
