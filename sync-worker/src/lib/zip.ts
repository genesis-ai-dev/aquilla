// Minimal store-only (no compression) ZIP writer — dependency-free and
// Worker-safe. Sufficient for bundling small text deliverables (USFM). Files
// are stored uncompressed; CRC32 is computed per the ZIP spec. We avoid adding
// a zip dependency to the worker so this never collides with parallel package
// work; STORE is fine for the modest sizes involved.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Running CRC32 state, so a streamed entry can be hashed chunk by chunk. */
const CRC_INIT = 0xffffffff

function crc32Update(state: number, buf: Uint8Array): number {
  let c = state
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0
}

function crc32(buf: Uint8Array): number {
  return crc32Final(crc32Update(CRC_INIT, buf))
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** Build a valid .zip (store method) from the given entries. */
export function makeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name)
    const crc = crc32(data)

    const lh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0x21, true) // mod date (1980-01-01)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // compressed size
    lv.setUint32(22, data.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    lh.set(nameBytes, 30)
    local.push(lh, data)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true) // central dir header signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true) // flags
    cv.setUint16(10, 0, true) // method
    cv.setUint16(12, 0, true) // mod time
    cv.setUint16(14, 0x21, true) // mod date
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true) // compressed size
    cv.setUint32(24, data.length, true) // uncompressed size
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra length
    cv.setUint16(32, 0, true) // comment length
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // local header offset
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += lh.length + data.length
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const centralOffset = offset

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central dir signature
  ev.setUint16(4, 0, true) // disk number
  ev.setUint16(6, 0, true) // disk with central dir
  ev.setUint16(8, entries.length, true) // entries on this disk
  ev.setUint16(10, entries.length, true) // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true) // comment length

  const all = [...local, ...central, eocd]
  const total = all.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of all) {
    out.set(c, p)
    p += c.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Streaming variant (AQU-1863)
//
// `makeZip` materialises every entry's bytes and then copies them into one
// output buffer, so a bundle of N originals costs ~2× their total size in
// Worker memory — two 50 MB originals already exceed the 128 MB limit. The
// streaming writer below never holds more than one chunk: it emits each entry's
// local header, pipes the entry's bytes straight through, and writes the CRC
// and sizes afterwards in a data descriptor (general-purpose flag bit 3), which
// is what lets the header go out before the bytes are known.
//
// Still STORE-only and still non-ZIP64, so the 4 GB per-entry / per-archive
// ceiling of `makeZip` applies here too; originals are capped far below it.
// ---------------------------------------------------------------------------

/** Flag bit 3: sizes and CRC follow the data in a data descriptor. */
const FLAG_DATA_DESCRIPTOR = 0x0008

export interface StreamZipEntry {
  name: string
  /**
   * Resolve the entry's bytes only when the writer reaches it. Returning
   * `null` skips the entry entirely — no header and no central-directory
   * record — which is how a blob that vanished from storage between the
   * existence check and the write is dropped mid-archive.
   */
  open: () => Promise<ReadableStream<Uint8Array> | Uint8Array | null>
}

function localHeader(nameBytes: Uint8Array): Uint8Array {
  const lh = new Uint8Array(30 + nameBytes.length)
  const lv = new DataView(lh.buffer)
  lv.setUint32(0, 0x04034b50, true) // local file header signature
  lv.setUint16(4, 20, true) // version needed
  lv.setUint16(6, FLAG_DATA_DESCRIPTOR, true)
  lv.setUint16(8, 0, true) // method: store
  lv.setUint16(10, 0, true) // mod time
  lv.setUint16(12, 0x21, true) // mod date (1980-01-01)
  lv.setUint32(14, 0, true) // crc — in the data descriptor
  lv.setUint32(18, 0, true) // compressed size — in the data descriptor
  lv.setUint32(22, 0, true) // uncompressed size — in the data descriptor
  lv.setUint16(26, nameBytes.length, true)
  lv.setUint16(28, 0, true) // extra length
  lh.set(nameBytes, 30)
  return lh
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const dd = new Uint8Array(16)
  const dv = new DataView(dd.buffer)
  dv.setUint32(0, 0x08074b50, true) // data descriptor signature
  dv.setUint32(4, crc, true)
  dv.setUint32(8, size, true) // compressed size
  dv.setUint32(12, size, true) // uncompressed size
  return dd
}

function centralHeader(
  nameBytes: Uint8Array,
  crc: number,
  size: number,
  offset: number,
): Uint8Array {
  const cd = new Uint8Array(46 + nameBytes.length)
  const cv = new DataView(cd.buffer)
  cv.setUint32(0, 0x02014b50, true) // central dir header signature
  cv.setUint16(4, 20, true) // version made by
  cv.setUint16(6, 20, true) // version needed
  cv.setUint16(8, FLAG_DATA_DESCRIPTOR, true)
  cv.setUint16(10, 0, true) // method
  cv.setUint16(12, 0, true) // mod time
  cv.setUint16(14, 0x21, true) // mod date
  cv.setUint32(16, crc, true)
  cv.setUint32(20, size, true) // compressed size
  cv.setUint32(24, size, true) // uncompressed size
  cv.setUint16(28, nameBytes.length, true)
  cv.setUint16(30, 0, true) // extra length
  cv.setUint16(32, 0, true) // comment length
  cv.setUint16(34, 0, true) // disk number
  cv.setUint16(36, 0, true) // internal attrs
  cv.setUint32(38, 0, true) // external attrs
  cv.setUint32(42, offset, true) // local header offset
  cd.set(nameBytes, 46)
  return cd
}

function endOfCentralDirectory(
  count: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central dir signature
  ev.setUint16(4, 0, true) // disk number
  ev.setUint16(6, 0, true) // disk with central dir
  ev.setUint16(8, count, true) // entries on this disk
  ev.setUint16(10, count, true) // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true) // comment length
  return eocd
}

async function* zipChunks(entries: StreamZipEntry[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder()
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const source = await entry.open()
    if (!source) continue

    const nameBytes = enc.encode(entry.name)
    const lh = localHeader(nameBytes)
    yield lh

    let crc = CRC_INIT
    let size = 0
    if (source instanceof Uint8Array) {
      crc = crc32Update(crc, source)
      size = source.length
      if (size > 0) yield source
    } else {
      const reader = source.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.length === 0) continue
          crc = crc32Update(crc, value)
          size += value.length
          yield value
        }
      } finally {
        reader.releaseLock()
      }
    }

    const finalCrc = crc32Final(crc)
    const dd = dataDescriptor(finalCrc, size)
    yield dd

    central.push(centralHeader(nameBytes, finalCrc, size, offset))
    offset += lh.length + size + dd.length
  }

  let centralSize = 0
  for (const c of central) {
    centralSize += c.length
    yield c
  }
  yield endOfCentralDirectory(central.length, centralSize, offset)
}

/**
 * Build a valid .zip (store method) as a stream, pulling each entry's bytes
 * only as the consumer drains the response. Peak memory is one source chunk
 * rather than the whole archive.
 */
export function makeZipStream(entries: StreamZipEntry[]): ReadableStream<Uint8Array> {
  const chunks = zipChunks(entries)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    async cancel(reason) {
      await chunks.return(reason)
    },
  })
}
