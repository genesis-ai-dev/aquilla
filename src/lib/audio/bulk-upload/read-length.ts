// AQU-981 (Sam, Oct 29): when the count can't tell whether a folder's lone
// numbers are chapters or verses, the recordings' length decides. Read it
// cheaply: a WAV's length is in its header, so only its first bytes are read;
// any other file asks the browser for its metadata, which reads the container's
// header (an MP3's frame header, an M4A's movie box) and never decodes the
// audio. A length it can't read is left out.

import { mapWithConcurrency } from "@/lib/concurrency"
import { probeMediaDurationMs } from "@/lib/import"

/** How much of a WAV is read to find its header: far more than any header. */
const WAV_HEAD_BYTES = 64 * 1024

/** A metadata read that never answers (a damaged file) gives up after this. */
const PROBE_TIMEOUT_MS = 10_000

/** Lengths read at once. */
const CONCURRENCY = 4

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

/**
 * A WAV's length from its header: the format chunk's bytes a second and the
 * data chunk's size. Walks the chunks, so a LIST or fact chunk before the data
 * is fine. Null when this isn't a whole RIFF/WAVE header. `fileBytes` is the
 * whole file's size, used when a recorder left the data size unset.
 */
export function wavLengthMs(head: Uint8Array, fileBytes = head.length): number | null {
  if (head.length < 12 || ascii(head, 0) !== "RIFF" || ascii(head, 8) !== "WAVE") return null
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  let byteRate = 0
  let at = 12
  while (at + 8 <= head.length) {
    const id = ascii(head, at)
    const size = dv.getUint32(at + 4, true)
    if (id === "fmt " && at + 20 <= head.length) byteRate = dv.getUint32(at + 16, true)
    if (id === "data") {
      if (!byteRate) return null
      const data = size === 0 || size === 0xffffffff ? fileBytes - (at + 8) : size
      return Math.round((data / byteRate) * 1000)
    }
    at += 8 + size + (size % 2)
  }
  return null
}

function isWav(file: File): boolean {
  return /\.wave?$/i.test(file.name) || /wav/i.test(file.type)
}

/** One recording's length in ms, or null when it can't be read cheaply. */
export async function recordingLengthMs(file: File): Promise<number | null> {
  if (isWav(file)) {
    const head = new Uint8Array(await file.slice(0, WAV_HEAD_BYTES).arrayBuffer())
    const ms = wavLengthMs(head, file.size)
    if (ms != null) return ms
  }
  try {
    const ms = await Promise.race([
      probeMediaDurationMs(file),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ])
    return ms != null && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null
  } catch {
    return null
  }
}

/** The lengths of `files[i]` for each i in `indices`, a few at a time. */
export async function readLengths(files: readonly File[], indices: readonly number[]): Promise<Map<number, number>> {
  const lengths = await mapWithConcurrency(indices, CONCURRENCY, async (i) => (files[i] ? recordingLengthMs(files[i]) : null))
  const out = new Map<number, number>()
  lengths.forEach((ms, k) => { if (ms != null) out.set(indices[k], ms) })
  return out
}
