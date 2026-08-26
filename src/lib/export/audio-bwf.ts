// Writing a take's place on the timeline INTO the take. (AQU-646, 2026-08-18)
//
// The per-line export hands over one file per recording, which is the shape a
// studio wants for review and re-recording — but on its own it throws away the
// one thing the app knows and a folder of files cannot say: WHERE each line
// belongs. codex-editor solves this by transcoding through ffmpeg with the
// cell's timestamps written into the container's metadata.
//
// We have no ffmpeg, and we do not need one. Broadcast Wave (BWF) is a plain
// WAV with one extra `bext` chunk, and the field that matters — `TimeReference`
// — is a 64-bit sample count from the start of the timeline. Every serious DAW
// reads it: dropping a folder of these in and choosing "place at original
// timecode" lays the whole episode out exactly as it was recorded, with none of
// the silence the per-character tracks carry.
//
// So this splices a chunk into bytes we already have, rather than decoding and
// re-encoding. It is lossless by construction: the audio bytes are untouched.
// A take that is not a WAV (a webm mic take) is passed through unchanged and
// relies on the manifest instead — see `audio-per-line.ts`.

/** `bext` is a fixed 602-byte payload before any coding history. */
const BEXT_PAYLOAD_BYTES = 602

const DESCRIPTION_BYTES = 256
const ORIGINATOR_BYTES = 32
const ORIGINATOR_REF_BYTES = 32
const DATE_BYTES = 10
const TIME_BYTES = 8

function ascii(view: DataView, offset: number, text: string, length: number): void {
  // Latin-1 and space-padded, per the spec — a name with an accent in it is
  // written as best it can be rather than corrupting the field's length.
  for (let i = 0; i < length; i += 1) {
    const code = i < text.length ? text.charCodeAt(i) : 0
    view.setUint8(offset + i, code > 0xff ? 0x3f /* '?' */ : code)
  }
}

export interface BextInfo {
  /** Free text — we put the character and the line in it. */
  description: string
  /** Who produced the file. */
  originator: string
  /** The cell id, so a file can always be traced back to its line. */
  originatorRef: string
  /** Where this take belongs, in samples from the start of the timeline. */
  timeReferenceSamples: number
}

/** Build the 602-byte `bext` payload. Exported for its own tests: every field
 *  is fixed-width, and a wrong offset silently corrupts the next one. */
export function buildBextPayload(info: BextInfo): Uint8Array {
  const bytes = new Uint8Array(BEXT_PAYLOAD_BYTES)
  const view = new DataView(bytes.buffer)
  let at = 0
  ascii(view, at, info.description, DESCRIPTION_BYTES); at += DESCRIPTION_BYTES
  ascii(view, at, info.originator, ORIGINATOR_BYTES); at += ORIGINATOR_BYTES
  ascii(view, at, info.originatorRef, ORIGINATOR_REF_BYTES); at += ORIGINATOR_REF_BYTES
  // OriginationDate / OriginationTime. Deliberately blank rather than stamped
  // with "now": an export is not a recording session, and a false date in a
  // broadcast header is worse than an absent one.
  ascii(view, at, "", DATE_BYTES); at += DATE_BYTES
  ascii(view, at, "", TIME_BYTES); at += TIME_BYTES
  // TimeReference, low then high word, little-endian. THE FIELD THIS EXISTS
  // FOR: a DAW asked to "place at original timecode" reads exactly this.
  const samples = Math.max(0, Math.round(info.timeReferenceSamples))
  view.setUint32(at, samples >>> 0, true)
  view.setUint32(at + 4, Math.floor(samples / 0x1_0000_0000), true)
  at += 8
  view.setUint16(at, 1, true) // Version 1
  // The remainder — UMID (64) and reserved (190) — stays zero, which is what
  // "no unique material identifier" means.
  return bytes
}

interface Chunk {
  id: string
  /** Offset of the chunk's PAYLOAD (after id + size). */
  start: number
  size: number
}

function readChunks(bytes: Uint8Array): { chunks: Chunk[]; valid: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return { chunks: [], valid: false }
  const chunks: Chunk[] = []
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const start = at + 8
    if (start + size > bytes.byteLength) {
      // A truncated final chunk — take what is there and stop rather than
      // reading past the buffer.
      chunks.push({ id, start, size: bytes.byteLength - start })
      break
    }
    chunks.push({ id, start, size })
    // Chunks are word-aligned: an odd size carries a pad byte that is not
    // counted in the size field. Missing this shifts every later chunk.
    at = start + size + (size % 2)
  }
  return { chunks, valid: true }
}

/**
 * Return `wav` with a `bext` chunk carrying this take's timeline position.
 *
 * Returns the input UNCHANGED when it is not a RIFF/WAVE file, so a caller can
 * pass every take through without checking first — a webm mic take simply
 * comes back as it went in.
 *
 * An existing `bext` is replaced rather than duplicated: two of them is not a
 * legal file, and re-exporting must be idempotent.
 */
export function withBwfTimestamp(wav: Uint8Array, info: BextInfo): Uint8Array {
  const { chunks, valid } = readChunks(wav)
  if (!valid) return wav

  const payload = buildBextPayload(info)

  // Rebuild from the chunk list rather than splicing blind, so the pad bytes
  // and any chunk we do not understand survive in place.
  const parts: Uint8Array[] = []
  const header = new Uint8Array(12)
  header.set(wav.subarray(0, 12))
  parts.push(header)

  const writeChunk = (id: string, body: Uint8Array) => {
    const head = new Uint8Array(8)
    const hv = new DataView(head.buffer)
    for (let i = 0; i < 4; i += 1) hv.setUint8(i, id.charCodeAt(i))
    hv.setUint32(4, body.byteLength, true)
    parts.push(head, body)
    if (body.byteLength % 2 === 1) parts.push(new Uint8Array(1))
  }

  // `bext` belongs before the audio data, which is where a reader expects to
  // find metadata and where every writer puts it.
  let written = false
  for (const chunk of chunks) {
    if (chunk.id === "bext") continue // dropped; the new one is written below
    if (!written && chunk.id === "data") {
      writeChunk("bext", payload)
      written = true
    }
    writeChunk(chunk.id, wav.subarray(chunk.start, chunk.start + chunk.size))
  }
  // A WAV with no `data` chunk is malformed, but appending is better than
  // silently dropping the timestamp.
  if (!written) writeChunk("bext", payload)

  let total = 0
  for (const part of parts) total += part.byteLength
  const bytes = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  // RIFF size counts everything after the size field itself.
  new DataView(bytes.buffer).setUint32(4, total - 8, true)
  return bytes
}
