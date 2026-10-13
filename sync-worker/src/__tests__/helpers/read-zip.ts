// Minimal STORE-only zip reader for tests (AQU-1863).
//
// `makeZipStream` writes entries with the data-descriptor flag, so the local
// headers carry zeroed sizes and only the central directory is authoritative.
// Reading entries the way a real unzip does — central directory first, then
// the local header — is what proves the streamed archive actually opens.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ReadZipEntry {
  name: string
  data: Uint8Array
  /** CRC32 recorded in the central directory (already checked against data). */
  crc: number
}

/** Parse a store-only zip, verifying each entry's recorded CRC32. */
export function readZip(zip: Uint8Array): ReadZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.byteLength - 22
  if (eocd < 0 || dv.getUint32(eocd, true) !== 0x06054b50) {
    throw new Error("end-of-central-directory record not found")
  }
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)

  const entries: ReadZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) {
      throw new Error(`central directory header ${i} malformed`)
    }
    const crc = dv.getUint32(p + 16, true)
    const compressedSize = dv.getUint32(p + 20, true)
    const uncompressedSize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (compressedSize !== uncompressedSize) {
      throw new Error(`entry ${name} is not stored uncompressed`)
    }
    if (dv.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`entry ${name} has no local file header at its recorded offset`)
    }
    const localNameLen = dv.getUint16(localOffset + 26, true)
    const localExtraLen = dv.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const data = zip.slice(start, start + uncompressedSize)
    if (data.length !== uncompressedSize) {
      throw new Error(`entry ${name} is truncated`)
    }
    if (crc32(data) !== crc) {
      throw new Error(`entry ${name} fails its CRC32 check`)
    }
    entries.push({ name, data, crc })
  }
  return entries
}
