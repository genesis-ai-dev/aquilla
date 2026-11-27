// Whether an imported media file carries a picture, read from its container
// rather than its name (import map D#2, Nov 2).
//
// The importer types a file by its extension, so every .webm is "video". But
// WebM is what browsers RECORD, and a recording made in a browser is usually
// sound only: typed as video, its upload was stored as the file's FILM, and the
// film track then showed a silent film with nothing to see. The same holds for
// an .mp4 or .mov saved without a picture.
//
// So a file named like a video is asked what tracks it holds:
//   - MP4, MOV, M4V (ISO base media): the `hdlr` boxes inside `moov` name each
//     track's kind; `vide` is a picture.
//   - WebM, MKV (Matroska): each TrackEntry inside Tracks has a TrackType;
//     1 is a picture.
// Only the container is read, never a codec, so a picture the browser cannot
// decode still counts as a picture. Anything that can't be read (an unknown
// container, a header past the bytes read) is "unknown", and the file keeps the
// type its name gave it: being unsure never takes a picture away.

import type { FileType } from "@/lib/parsers/types"

/** The most of a file read to find its tracks. Matroska keeps them near the
 *  start; an ISO `moov` is read whole, and is a few MB even for an episode. */
const MATROSKA_HEAD_BYTES = 4 * 1024 * 1024
const ISO_MOOV_MAX_BYTES = 64 * 1024 * 1024
const ISO_TOP_LEVEL_BOXES = 4096

async function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer())
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = ""
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

function uint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
}

/**
 * True when the file has a picture track, false when its tracks were read and
 * none is a picture, undefined when its tracks could not be read.
 */
export async function mediaHasPicture(file: Blob): Promise<boolean | undefined> {
  if (file.size < 12) return undefined
  const head = await readBytes(file, 0, 12)
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return matroskaHasPicture(await readBytes(file, 0, MATROSKA_HEAD_BYTES))
  }
  if (["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"].includes(ascii(head, 4, 8))) {
    return isoHasPicture(file)
  }
  return undefined
}

/**
 * The type a media upload is stored as: a file named like a video whose
 * tracks hold no picture comes in as audio. Anything else keeps its type.
 */
export async function importedMediaType(file: Blob, typeFromName: FileType): Promise<FileType> {
  if (typeFromName !== "video") return typeFromName
  const picture = await mediaHasPicture(file).catch(() => undefined)
  return picture === false ? "audio" : "video"
}

// ── ISO base media (MP4, MOV, M4V) ──────────────────────────────────────────

async function isoHasPicture(file: Blob): Promise<boolean | undefined> {
  let offset = 0
  for (let box = 0; box < ISO_TOP_LEVEL_BOXES && offset + 8 <= file.size; box++) {
    const header = await readBytes(file, offset, offset + 16)
    let size = uint32(header, 0)
    const type = ascii(header, 4, 8)
    let headerLength = 8
    if (size === 1) {
      if (header.length < 16) return undefined
      size = uint32(header, 8) * 2 ** 32 + uint32(header, 12)
      headerLength = 16
    } else if (size === 0) {
      size = file.size - offset
    }
    if (size < headerLength) return undefined
    if (type === "moov") {
      if (size > ISO_MOOV_MAX_BYTES) return undefined
      return handlersHavePicture(await readBytes(file, offset + headerLength, offset + size))
    }
    offset += size
  }
  return undefined
}

/** Every `hdlr` box: [size][hdlr][version+flags][pre_defined][handler type]. */
function handlersHavePicture(moov: Uint8Array): boolean | undefined {
  let sawHandler = false
  for (let i = 0; i + 16 <= moov.length; i++) {
    if (moov[i] !== 0x68 || moov[i + 1] !== 0x64 || moov[i + 2] !== 0x6c || moov[i + 3] !== 0x72) continue
    const handler = ascii(moov, i + 12, i + 16)
    if (handler === "vide") return true
    if (handler === "soun" || handler === "text" || handler === "sbtl" || handler === "subt"
      || handler === "tmcd" || handler === "meta" || handler === "hint") sawHandler = true
  }
  return sawHandler ? false : undefined
}

// ── Matroska (WebM, MKV) ────────────────────────────────────────────────────

const EBML_HEADER = 0x1a45dfa3
const SEGMENT = 0x18538067
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_TYPE = 0x83
const CLUSTER = 0x1f43b675
const TRACK_TYPE_VIDEO = 1

interface Element { id: number; dataStart: number; dataEnd: number }

/** An element ID keeps its length-marker bits; 1–4 bytes. */
function readId(bytes: Uint8Array, at: number): { id: number; length: number } | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const length = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0
  if (length === 0 || at + length > bytes.length) return null
  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i]
  return { id, length }
}

/** A size drops its marker bit; all ones means "unknown", read as to the end. */
function readSize(bytes: Uint8Array, at: number): { size: number | null; length: number } | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++
  if (length > 8 || at + length > bytes.length) return null
  let value = first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]
    if (bytes[at + i] !== 0xff) allOnes = false
  }
  return { size: allOnes ? null : value, length }
}

function readElement(bytes: Uint8Array, at: number, parentEnd: number): Element | null {
  const id = readId(bytes, at)
  if (!id) return null
  const size = readSize(bytes, at + id.length)
  if (!size) return null
  const dataStart = at + id.length + size.length
  const dataEnd = size.size === null ? parentEnd : dataStart + size.size
  return { id: id.id, dataStart, dataEnd }
}

function children(bytes: Uint8Array, start: number, end: number): Element[] {
  const out: Element[] = []
  let at = start
  const limit = Math.min(end, bytes.length)
  while (at < limit) {
    const element = readElement(bytes, at, end)
    if (!element || element.dataEnd <= at) break
    out.push(element)
    at = element.dataEnd
  }
  return out
}

function matroskaHasPicture(bytes: Uint8Array): boolean | undefined {
  const top = readElement(bytes, 0, bytes.length)
  if (!top || top.id !== EBML_HEADER) return undefined
  const segment = readElement(bytes, top.dataEnd, bytes.length)
  if (!segment || segment.id !== SEGMENT) return undefined
  let at = segment.dataStart
  while (at < bytes.length) {
    const element = readElement(bytes, at, segment.dataEnd)
    if (!element || element.dataEnd <= at) return undefined
    if (element.id === CLUSTER) return undefined
    if (element.id === TRACKS) {
      if (element.dataEnd > bytes.length) return undefined
      let sawTrack = false
      for (const entry of children(bytes, element.dataStart, element.dataEnd)) {
        if (entry.id !== TRACK_ENTRY) continue
        for (const field of children(bytes, entry.dataStart, entry.dataEnd)) {
          if (field.id !== TRACK_TYPE) continue
          sawTrack = true
          let value = 0
          for (let i = field.dataStart; i < field.dataEnd; i++) value = value * 256 + bytes[i]
          if (value === TRACK_TYPE_VIDEO) return true
        }
      }
      return sawTrack ? false : undefined
    }
    at = element.dataEnd
  }
  return undefined
}
