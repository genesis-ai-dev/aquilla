// Cut a long WAV into upload-sized WAVs without decoding it (AQU-2573).
//
// Train voice needs at least 5 minutes of speech, and the worker takes one
// recording per request, 20 MB at most. Uncompressed studio audio passes 20 MB
// in about two minutes, so the recording a partner is most likely to have could
// never meet the minimum. The training service joins a voice's clips in order
// anyway, so a long WAV goes up as several short ones.
//
// The cut is lossless and costs no memory: each piece is a new RIFF header (the
// original `fmt ` chunk, byte for byte) in front of a `Blob.slice` of the
// original samples, cut on a whole sample frame. Nothing is read but the
// chunk headers.

const RIFF_HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8
/** A `fmt ` chunk is 16–40 bytes; anything far past that is not a WAV we know. */
const MAX_FMT_BYTES = 256
/** Give up looking for `data` after this many chunks (a corrupt size field loops). */
const MAX_CHUNKS = 64

const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_IEEE_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

export interface WavSplit {
  /** Length of the whole recording, from its header. */
  seconds: number
  /** The recording as WAV files of at most the asked size, in order. */
  parts: File[]
}

const ascii = (view: DataView, at: number) =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))

async function read(file: Blob, start: number, length: number): Promise<DataView | null> {
  if (start + length > file.size) return null
  return new DataView(await file.slice(start, start + length).arrayBuffer())
}

function wavHeader(fmt: Uint8Array, dataBytes: number): Uint8Array<ArrayBuffer> {
  const fmtPadded = fmt.byteLength + (fmt.byteLength % 2)
  const out = new Uint8Array(RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES + fmtPadded + CHUNK_HEADER_BYTES)
  const view = new DataView(out.buffer)
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i) }
  tag(0, "RIFF")
  view.setUint32(4, out.byteLength - CHUNK_HEADER_BYTES + dataBytes + (dataBytes % 2), true)
  tag(8, "WAVE")
  tag(12, "fmt ")
  view.setUint32(16, fmt.byteLength, true)
  out.set(fmt, 20)
  tag(20 + fmtPadded, "data")
  view.setUint32(24 + fmtPadded, dataBytes, true)
  return out
}

/**
 * Split an uncompressed WAV into WAVs of at most `maxPartBytes`. Null when the
 * file is not one this can cut safely (not a WAV, a compressed WAV, RF64, a
 * header that does not add up) — the caller then treats it like any other file.
 */
export async function splitWav(file: File, maxPartBytes: number): Promise<WavSplit | null> {
  const riff = await read(file, 0, RIFF_HEADER_BYTES)
  if (!riff || ascii(riff, 0) !== "RIFF" || ascii(riff, 8) !== "WAVE") return null

  let fmt: Uint8Array | null = null
  let dataStart = -1
  let dataBytes = 0
  let at = RIFF_HEADER_BYTES
  for (let i = 0; i < MAX_CHUNKS && dataStart < 0; i++) {
    const head = await read(file, at, CHUNK_HEADER_BYTES)
    if (!head) return null
    const id = ascii(head, 0)
    const size = head.getUint32(4, true)
    const body = at + CHUNK_HEADER_BYTES
    if (id === "fmt ") {
      if (size < 16 || size > MAX_FMT_BYTES) return null
      const bytes = await read(file, body, size)
      if (!bytes) return null
      fmt = new Uint8Array(bytes.buffer)
    } else if (id === "data") {
      dataStart = body
      // A recorder that never went back to fill the size in writes 0 or all
      // ones; the samples then run to the end of the file.
      dataBytes = size === 0 || size === 0xffffffff || body + size > file.size ? file.size - body : size
    }
    at = body + size + (size % 2)
  }
  if (!fmt || dataStart < 0) return null

  const fmtView = new DataView(fmt.buffer)
  const format = fmtView.getUint16(0, true)
  if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_IEEE_FLOAT && format !== WAVE_FORMAT_EXTENSIBLE) return null
  const byteRate = fmtView.getUint32(8, true)
  const blockAlign = fmtView.getUint16(12, true)
  if (byteRate <= 0 || blockAlign <= 0) return null

  const headerBytes = wavHeader(fmt, 0).byteLength
  const partData = Math.floor((maxPartBytes - headerBytes) / blockAlign) * blockAlign
  const usable = Math.floor(dataBytes / blockAlign) * blockAlign
  if (partData <= 0 || usable <= 0) return null

  const stem = file.name.replace(/\.[^.]*$/, "") || "recording"
  const count = Math.ceil(usable / partData)
  const digits = String(count).length
  const parts: File[] = []
  for (let i = 0; i < count; i++) {
    const from = i * partData
    const length = Math.min(partData, usable - from)
    parts.push(new File(
      [wavHeader(fmt, length), file.slice(dataStart + from, dataStart + from + length)],
      `${stem}-part${String(i + 1).padStart(digits, "0")}.wav`,
      { type: "audio/wav" },
    ))
  }
  return { seconds: usable / byteRate, parts }
}
