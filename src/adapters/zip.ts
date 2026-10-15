/**
 * Minimal ZIP reader/writer that preserves untouched members byte-for-byte.
 *
 * Native artifact preservation matters more than generality here: when a
 * localized IDML is produced, every member we did not change (spreads, styles,
 * links, metadata…) is copied as the *original compressed bytes* with its
 * original local and central-directory headers. Only changed members are
 * recompressed. If nothing changed, the output is the input, byte-identical.
 *
 * Not supported (rejected explicitly): ZIP64, encryption, multi-disk archives,
 * compression methods other than stored (0) and deflate (8).
 */
import { deflateSync, inflateSync } from "fflate"

export class ZipError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface ZipEntry {
  readonly name: string
  readonly method: 0 | 8
  readonly crc32: number
  readonly compressedSize: number
  readonly size: number
  readonly flags: number
  /** Exact local record (header + name + extra + data + optional descriptor). */
  readonly localRecord: Uint8Array
  /** Exact central-directory record; offset field is rewritten on output. */
  readonly centralRecord: Uint8Array
  readonly dataOffsetInRecord: number
}

export interface ZipArchive {
  readonly entries: ZipEntry[]
  readonly comment: Uint8Array
  readonly bytes: Uint8Array
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8)
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
const w16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
}
const w32 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
  b[o + 2] = (v >>> 16) & 0xff
  b[o + 3] = (v >>> 24) & 0xff
}

const MAX_ENTRIES = 20_000
const MAX_TOTAL = 1024 * 1024 * 1024
const MAX_RATIO = 200

export const readZip = (bytes: Uint8Array): ZipArchive => {
  if (bytes.length < 22) throw new ZipError("INVALID_ZIP", "file too small to be a ZIP archive")
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError("INVALID_ZIP", "end of central directory not found")
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) throw new ZipError("UNSUPPORTED_ZIP", "multi-disk archives are not supported")
  const count = u16(bytes, eocd + 10)
  const cdSize = u32(bytes, eocd + 12)
  const cdOffset = u32(bytes, eocd + 16)
  const commentLen = u16(bytes, eocd + 20)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("UNSUPPORTED_ZIP", "ZIP64 archives are not supported")
  if (count > MAX_ENTRIES) throw new ZipError("TOO_MANY_ENTRIES", `${count} entries exceeds limit`)
  if (cdOffset + cdSize > eocd) throw new ZipError("INVALID_ZIP", "central directory out of bounds")
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let total = 0
  let p = cdOffset
  const dec = new TextDecoder("utf-8", { fatal: false })
  for (let k = 0; k < count; k++) {
    if (u32(bytes, p) !== 0x02014b50) throw new ZipError("INVALID_ZIP", "bad central directory signature")
    const flags = u16(bytes, p + 8)
    const method = u16(bytes, p + 10)
    const crc = u32(bytes, p + 16)
    const csize = u32(bytes, p + 20)
    const size = u32(bytes, p + 24)
    const nlen = u16(bytes, p + 28)
    const xlen = u16(bytes, p + 30)
    const clen = u16(bytes, p + 32)
    const lho = u32(bytes, p + 42)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen))
    const centralRecord = bytes.slice(p, p + 46 + nlen + xlen + clen)
    p += 46 + nlen + xlen + clen
    if (flags & 1) throw new ZipError("ENCRYPTED_MEMBER", `${name} is encrypted`)
    if (method !== 0 && method !== 8) throw new ZipError("UNSUPPORTED_COMPRESSION", `${name} uses compression method ${method}`)
    if (names.has(name)) throw new ZipError("DUPLICATE_MEMBER", `${name} appears twice`)
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) throw new ZipError("UNSAFE_MEMBER_PATH", `unsafe member path ${name}`)
    names.add(name)
    total += size
    if (total > MAX_TOTAL) throw new ZipError("EXPANSION_TOO_LARGE", "archive expands beyond the size limit")
    if (csize > 0 && size / csize > MAX_RATIO && size > 1024 * 1024) throw new ZipError("COMPRESSION_RATIO_EXCEEDED", `${name} has a suspicious compression ratio`)
    if (u32(bytes, lho) !== 0x04034b50) throw new ZipError("INVALID_ZIP", `bad local header for ${name}`)
    const lnlen = u16(bytes, lho + 26)
    const lxlen = u16(bytes, lho + 28)
    const dataStart = 30 + lnlen + lxlen
    let recordLen = dataStart + csize
    if (flags & 0x8) {
      const d = lho + recordLen
      recordLen += u32(bytes, d) === 0x08074b50 ? 16 : 12
    }
    if (lho + recordLen > bytes.length) throw new ZipError("INVALID_ZIP", `${name} data out of bounds`)
    entries.push({
      name,
      method: method as 0 | 8,
      crc32: crc,
      compressedSize: csize,
      size,
      flags,
      localRecord: bytes.subarray(lho, lho + recordLen),
      centralRecord,
      dataOffsetInRecord: dataStart,
    })
  }
  return { entries, comment: bytes.slice(eocd + 22, eocd + 22 + commentLen), bytes }
}

export const entryData = (e: ZipEntry): Uint8Array => {
  const raw = e.localRecord.subarray(e.dataOffsetInRecord, e.dataOffsetInRecord + e.compressedSize)
  const out = e.method === 0 ? raw.slice() : inflateSync(raw, { out: new Uint8Array(e.size) })
  if (out.length !== e.size) throw new ZipError("INVALID_ZIP", `${e.name} inflated to ${out.length} bytes, expected ${e.size}`)
  if (crc32(out) !== e.crc32) throw new ZipError("INVALID_ZIP", `${e.name} failed its CRC check`)
  return out
}

export const entryText = (e: ZipEntry): string => new TextDecoder("utf-8").decode(entryData(e))

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Write a new archive. `replacements` maps member name → new uncompressed
 * bytes; every other member is copied verbatim. Member order is preserved.
 * Returns the original bytes unchanged when there is nothing to replace.
 */
export const rewriteZip = (archive: ZipArchive, replacements: ReadonlyMap<string, Uint8Array>): Uint8Array => {
  const effective = new Map<string, Uint8Array>()
  for (const [name, data] of replacements) {
    const e = archive.entries.find((x) => x.name === name)
    if (!e) throw new ZipError("MEMBER_MISSING", `cannot replace missing member ${name}`)
    if (e.size === data.length && crc32(data) === e.crc32 && bytesEqual(entryData(e), data)) continue
    effective.set(name, data)
  }
  if (effective.size === 0) return archive.bytes

  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  const enc = new TextEncoder()
  for (const e of archive.entries) {
    const data = effective.get(e.name)
    let local: Uint8Array
    let central: Uint8Array
    if (!data) {
      local = e.localRecord
      central = e.centralRecord.slice()
    } else {
      // mimetype must stay stored; everything else is deflated.
      const method: 0 | 8 = e.name === "mimetype" ? 0 : 8
      const comp = method === 0 ? data : deflateSync(data, { level: 6 })
      const crc = crc32(data)
      const nameBytes = enc.encode(e.name)
      const time = u16(e.centralRecord, 12)
      const date = u16(e.centralRecord, 14)
      const flags = e.flags & 0x0800 // keep only the UTF-8 flag; no descriptor
      local = new Uint8Array(30 + nameBytes.length + comp.length)
      w32(local, 0, 0x04034b50)
      w16(local, 4, 20)
      w16(local, 6, flags)
      w16(local, 8, method)
      w16(local, 10, time)
      w16(local, 12, date)
      w32(local, 14, crc)
      w32(local, 18, comp.length)
      w32(local, 22, data.length)
      w16(local, 26, nameBytes.length)
      w16(local, 28, 0)
      local.set(nameBytes, 30)
      local.set(comp, 30 + nameBytes.length)
      central = new Uint8Array(46 + nameBytes.length)
      w32(central, 0, 0x02014b50)
      w16(central, 4, u16(e.centralRecord, 4))
      w16(central, 6, 20)
      w16(central, 8, flags)
      w16(central, 10, method)
      w16(central, 12, time)
      w16(central, 14, date)
      w32(central, 16, crc)
      w32(central, 20, comp.length)
      w32(central, 24, data.length)
      w16(central, 28, nameBytes.length)
      w32(central, 38, u32(e.centralRecord, 38))
      central.set(nameBytes, 46)
    }
    w32(central, 42, offset)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22 + archive.comment.length)
  w32(eocd, 0, 0x06054b50)
  w16(eocd, 8, archive.entries.length)
  w16(eocd, 10, archive.entries.length)
  w32(eocd, 12, cdSize)
  w32(eocd, 16, offset)
  w16(eocd, 20, archive.comment.length)
  eocd.set(archive.comment, 22)
  const out = new Uint8Array(offset + cdSize + eocd.length)
  let p = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** Build a fresh archive (used by fixture generators). mimetype is stored first. */
export const buildZip = (files: ReadonlyArray<readonly [string, Uint8Array | string]>): Uint8Array => {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = typeof content === "string" ? enc.encode(content) : content
    const method = name === "mimetype" ? 0 : 8
    const comp = method === 0 ? data : deflateSync(data, { level: 6 })
    const nameBytes = enc.encode(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + comp.length)
    w32(local, 0, 0x04034b50)
    w16(local, 4, 20)
    w16(local, 6, 0x0800)
    w16(local, 8, method)
    w16(local, 10, 0)
    w16(local, 12, 0x21)
    w32(local, 14, crc)
    w32(local, 18, comp.length)
    w32(local, 22, data.length)
    w16(local, 26, nameBytes.length)
    local.set(nameBytes, 30)
    local.set(comp, 30 + nameBytes.length)
    const central = new Uint8Array(46 + nameBytes.length)
    w32(central, 0, 0x02014b50)
    w16(central, 4, 20)
    w16(central, 6, 20)
    w16(central, 8, 0x0800)
    w16(central, 10, method)
    w16(central, 14, 0x21)
    w32(central, 16, crc)
    w32(central, 20, comp.length)
    w32(central, 24, data.length)
    w16(central, 28, nameBytes.length)
    w32(central, 42, offset)
    central.set(nameBytes, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  w32(eocd, 0, 0x06054b50)
  w16(eocd, 8, files.length)
  w16(eocd, 10, files.length)
  w32(eocd, 12, cdSize)
  w32(eocd, 16, offset)
  const out = new Uint8Array(offset + cdSize + 22)
  let p = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p)
    p += part.length
  }
  return out
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
