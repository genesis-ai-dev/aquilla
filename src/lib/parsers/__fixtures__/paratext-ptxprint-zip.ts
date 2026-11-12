// Paratext export whose PTXprint helper has an unreadable size (AQU-1406).
//
// A consultant's export from a machine with PTXprint installed killed the whole
// import: "Paratext ZIP contains an entry with invalid size metadata:
// shared/ptxprint/Default/FRTlocal.sfm". This module writes an archive that
// reproduces that condition in real bytes, so the regression guard exercises the
// actual JSZip path instead of stubbing a loaded entry's metadata.
//
// How the condition is expressed: the member's 32-bit uncompressed size is set
// to the 0xFFFFFFFF sentinel that means "see the ZIP64 extra field", and the
// ZIP64 field then carries a 64-bit size above 2^53. JSZip parses that field
// happily — the archive loads, every other member is intact — but the value
// cannot survive as a JS safe integer, so the size reads back unusable. Note a
// *truncated* ZIP64 field does not work here: JSZip's reader runs off the end
// and `loadAsync` itself throws, which never reaches the archive-safety gate.
//
// Written by hand with STORED members, following __fixtures__/docx-parity.ts.

const encoder = new TextEncoder()

/** The PTXprint layout helper from the reported export. */
export const PTXPRINT_HELPER_PATH = "shared/ptxprint/Default/FRTlocal.sfm"

/** A book file, named as Paratext names them for this project. */
export const PARATEXT_BOOK_PATH = "44ACTSibtatar.SFM"

interface ZipMember {
  name: string
  content: string
  /** Give this member an unreadable uncompressed size (see module comment). */
  unreadableSize?: boolean
}

const PROJECT_MEMBERS: ZipMember[] = [
  { name: "Settings.xml", content: "<ScriptureText><Name>sibtatar</Name></ScriptureText>" },
  { name: "01GENSibtatar.SFM", content: "\\id GEN\n\\c 1\n\\v 1 Source text" },
  { name: PARATEXT_BOOK_PATH, content: "\\id ACT\n\\c 1\n\\v 1 Source text" },
  { name: PTXPRINT_HELPER_PATH, content: "\\id FRT\n\\mt PTXprint front matter" },
]

/** Every member this fixture contains, in archive order. */
export const PARATEXT_PTXPRINT_MEMBER_NAMES = PROJECT_MEMBERS.map((m) => m.name)

/**
 * Build the export's bytes, with `unreadableMember` carrying the unreadable
 * size. Pass the helper path for the reported bug; pass a book path to check
 * that a member the importer *needs* still fails the import.
 * Deterministic — same bytes every call.
 */
export function buildParatextPtxprintZip(unreadableMember: string): Uint8Array<ArrayBuffer> {
  if (!PROJECT_MEMBERS.some((m) => m.name === unreadableMember)) {
    throw new Error(`${unreadableMember} is not a member of this fixture`)
  }
  return writeStoredZip(
    PROJECT_MEMBERS.map((m) => ({ ...m, unreadableSize: m.name === unreadableMember })),
  )
}

// ── minimal STORED-only zip writer ───────────────────────────────────────────

/** "Size lives in the ZIP64 extra field" sentinel. */
const ZIP64_SENTINEL = 0xffffffff
/** ZIP64 extended-information extra field header id. */
const ZIP64_FIELD_ID = 0x0001
/** A 64-bit size above Number.MAX_SAFE_INTEGER (2^60). */
const UNREPRESENTABLE_SIZE_HIGH_WORD = 0x10000000

function writeStoredZip(members: ZipMember[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const member of members) {
    const nameBytes = encoder.encode(member.name)
    const data = encoder.encode(member.content)
    const crc = crc32(data)

    // The local header always states the true size: the archive stays readable
    // and the member's bytes are recoverable. Only the central directory — what
    // the safety gate inspects before reading anything — is unusable.
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true) // local file header signature
    localView.setUint16(4, 20, true) // version needed
    localView.setUint16(6, 0, true) // flags
    localView.setUint16(8, 0, true) // method: stored
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true) // compressed size
    localView.setUint32(22, data.length, true) // uncompressed size
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    const extra = member.unreadableSize ? zip64SizeField() : new Uint8Array(0)
    const central = new Uint8Array(46 + nameBytes.length + extra.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true) // central directory signature
    centralView.setUint16(4, 20, true) // version made by
    centralView.setUint16(6, 20, true) // version needed
    centralView.setUint16(10, 0, true) // method: stored
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, data.length, true) // compressed size
    centralView.setUint32(24, member.unreadableSize ? ZIP64_SENTINEL : data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, extra.length, true)
    centralView.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)
    central.set(extra, 46 + nameBytes.length)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, members.length, true) // entries on this disk
  eocdView.setUint16(10, members.length, true) // total entries
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true) // central directory offset

  return concat([...locals, ...centrals, eocd])
}

/** A well-formed ZIP64 field holding one 64-bit size too large for a JS
 *  safe integer. Full length, so the archive still parses. */
function zip64SizeField(): Uint8Array {
  const field = new Uint8Array(12)
  const view = new DataView(field.buffer)
  view.setUint16(0, ZIP64_FIELD_ID, true)
  view.setUint16(2, 8, true) // payload: one 8-byte size
  view.setUint32(4, 0, true) // low word
  view.setUint32(8, UNREPRESENTABLE_SIZE_HIGH_WORD, true) // high word
  return field
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

let CRC_TABLE: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
