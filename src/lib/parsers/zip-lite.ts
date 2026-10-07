// Minimal, dependency-free ZIP member reader (AQU-1237).
//
// JSZip is a browser/Node library and a heavy thing to drag into a Cloudflare
// Worker bundle; auth-worker reaches for `fflate` instead, which means the two
// sides of an OOXML import would decompress through different code. This reader
// uses `DecompressionStream("deflate-raw")` — a platform API present in
// browsers, Node 18+, and Workers — so the SAME extraction runs everywhere and
// no zip dependency is needed at all.
//
// Scope: read named members out of a well-formed archive. No writing, no
// streaming of huge archives, no encryption, no ZIP64 (a >4GB OOXML part is far
// past every import cap this repo enforces). Entry metadata is read from the
// CENTRAL DIRECTORY, never the local header, so archives written with data
// descriptors (JSZip's `generateAsync` among them) report correct sizes.

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
/** The EOCD sits at the end, after an optional ≤64KB comment. */
const MAX_EOCD_SEARCH = EOCD_MIN_SIZE + 0xffff

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

export interface ZipLiteEntry {
  name: string
  /** Directory entries are recorded but hold no content. */
  isDirectory: boolean
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
}

export interface ZipLiteArchive {
  entries: ZipLiteEntry[]
  /** Members by exact name, for O(1) lookup of well-known OOXML parts. */
  byName: Map<string, ZipLiteEntry>
  bytes: Uint8Array
}

/** Read the central directory. Does NOT decompress anything. */
export function readZipLite(input: ArrayBuffer | Uint8Array): ZipLiteArchive {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const eocd = findEocd(view, bytes.length)
  if (eocd === -1) throw new Error("Not a ZIP archive (no end-of-central-directory record).")

  const entryCount = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (directoryOffset > bytes.length) throw new Error("ZIP central directory offset is out of range.")

  const entries: ZipLiteEntry[] = []
  const byName = new Map<string, ZipLiteEntry>()
  const decoder = new TextDecoder("utf-8")
  let offset = directoryOffset

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length) throw new Error("ZIP central directory is truncated.")
    if (view.getUint32(offset, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error("ZIP central directory entry has a bad signature.")
    }
    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.length) throw new Error("ZIP central directory is truncated.")
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd))

    const entry: ZipLiteEntry = {
      name,
      isDirectory: name.endsWith("/"),
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    }
    entries.push(entry)
    // First writer of a duplicated name wins, matching JSZip's load order.
    if (!byName.has(name)) byName.set(name, entry)
    offset = nameEnd + extraLength + commentLength
  }

  return { entries, byName, bytes }
}

/** Inflate one member to bytes. Returns null when the archive has no such member. */
export async function readZipLiteEntryBytes(
  archive: ZipLiteArchive,
  name: string,
): Promise<Uint8Array | null> {
  const entry = archive.byName.get(name)
  if (!entry || entry.isDirectory) return null

  const { bytes } = archive
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = entry.localHeaderOffset
  if (header + 30 > bytes.length) throw new Error(`ZIP entry "${name}" has a truncated local header.`)
  if (view.getUint32(header, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`ZIP entry "${name}" has a bad local header signature.`)
  }
  // The local header's own name/extra lengths locate the data; its size fields
  // are the ones that may be zeroed by a data descriptor, so they go unused.
  const nameLength = view.getUint16(header + 26, true)
  const extraLength = view.getUint16(header + 28, true)
  const dataStart = header + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.length) throw new Error(`ZIP entry "${name}" data runs past the end of the archive.`)
  const data = bytes.subarray(dataStart, dataEnd)

  if (entry.compressionMethod === METHOD_STORED) return data
  if (entry.compressionMethod !== METHOD_DEFLATE) {
    throw new Error(`ZIP entry "${name}" uses unsupported compression method ${entry.compressionMethod}.`)
  }
  return inflateRaw(data)
}

/** Inflate one member and decode it as UTF-8 (BOM stripped). */
export async function readZipLiteEntryText(
  archive: ZipLiteArchive,
  name: string,
): Promise<string | null> {
  const inflated = await readZipLiteEntryBytes(archive, name)
  if (inflated === null) return null
  const text = new TextDecoder("utf-8").decode(inflated)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is unavailable — cannot inflate ZIP members on this platform.")
  }
  // Driven through the writer rather than `pipeThrough` because the DOM and
  // Workers lib sets type the transform's writable side differently
  // (WritableStream<BufferSource> vs WritableStream<Uint8Array>) and this file
  // is compiled under both. The write is deliberately NOT awaited: the read
  // below consumes concurrently, which is what keeps a member larger than the
  // stream's internal queue from deadlocking. Failures surface on the read
  // side, so the write promise is neutralized to avoid an unhandled rejection.
  const stream = new DecompressionStream("deflate-raw")
  const writer = stream.writable.getWriter()
  // Copied into a fresh, definitely-ArrayBuffer-backed view: `data` is a
  // subarray of the caller's buffer, which TypeScript types as
  // Uint8Array<ArrayBufferLike> (possibly SharedArrayBuffer) and the stream
  // writer will not accept.
  const chunk = new Uint8Array(data.length)
  chunk.set(data)
  void writer
    .write(chunk)
    .then(() => writer.close())
    .catch(() => {})
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

function findEocd(view: DataView, length: number): number {
  const floor = Math.max(0, length - MAX_EOCD_SEARCH)
  for (let i = length - EOCD_MIN_SIZE; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i
  }
  return -1
}
