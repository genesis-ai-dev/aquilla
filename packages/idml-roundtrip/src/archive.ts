import { IdmlError } from "./errors.js"
import type {
  IdmlArchiveMember,
  IdmlDiagnosticCode,
  IdmlLimits,
  IdmlPackageInspection,
} from "./types.js"

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50

const LOCAL_FILE_HEADER_LENGTH = 30
const CENTRAL_DIRECTORY_HEADER_LENGTH = 46
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22
const MAX_ZIP_COMMENT_LENGTH = 0xffff
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff
const ZIP64_EXTRA_FIELD_ID = 0x0001
const UTF8_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008
const ENCRYPTION_FLAGS = 0x2041

const IDML_MIMETYPE = "application/vnd.adobe.indesign-idml-package" as const
const IDML_MIMETYPE_BYTES = new TextEncoder().encode(IDML_MIMETYPE)

const CP437_HIGH_CHARACTERS = Array.from(
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
    "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
    "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
)

export const DEFAULT_IDML_LIMITS: Readonly<IdmlLimits> = Object.freeze({
  maxInputBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
})

interface EndOfCentralDirectory {
  readonly entryCount: number
  readonly centralDirectoryOffset: number
  readonly centralDirectorySize: number
}

interface ParsedCentralMember {
  readonly member: IdmlArchiveMember
  readonly normalizedPath: string
  readonly flags: number
  readonly rawName: Uint8Array
  readonly centralExtraLength: number
}

interface ParsedLocalMember {
  readonly central: ParsedCentralMember
  readonly dataOffset: number
  readonly endOffset: number
  readonly localExtraLength: number
}

export function normalizeIdmlBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return new Uint8Array(bytes)
}

export function resolveIdmlLimits(limits?: Partial<IdmlLimits>): Readonly<IdmlLimits> {
  const resolved: IdmlLimits = {
    maxInputBytes: limits?.maxInputBytes ?? DEFAULT_IDML_LIMITS.maxInputBytes,
    maxEntries: limits?.maxEntries ?? DEFAULT_IDML_LIMITS.maxEntries,
    maxEntryUncompressedBytes:
      limits?.maxEntryUncompressedBytes ?? DEFAULT_IDML_LIMITS.maxEntryUncompressedBytes,
    maxTotalUncompressedBytes:
      limits?.maxTotalUncompressedBytes ?? DEFAULT_IDML_LIMITS.maxTotalUncompressedBytes,
    maxCompressionRatio: limits?.maxCompressionRatio ?? DEFAULT_IDML_LIMITS.maxCompressionRatio,
  }

  assertNonNegativeIntegerLimit("maxInputBytes", resolved.maxInputBytes)
  assertNonNegativeIntegerLimit("maxEntries", resolved.maxEntries)
  assertNonNegativeIntegerLimit(
    "maxEntryUncompressedBytes",
    resolved.maxEntryUncompressedBytes,
  )
  assertNonNegativeIntegerLimit(
    "maxTotalUncompressedBytes",
    resolved.maxTotalUncompressedBytes,
  )
  if (!Number.isFinite(resolved.maxCompressionRatio) || resolved.maxCompressionRatio < 0) {
    fail(
      "EXPORT_REJECTED",
      "IDML limit maxCompressionRatio must be a finite, non-negative number",
      undefined,
      { limit: "maxCompressionRatio", value: resolved.maxCompressionRatio },
    )
  }

  return Object.freeze(resolved)
}

export async function inspectIdml(
  input: Uint8Array | ArrayBuffer,
  requestedLimits?: Partial<IdmlLimits>,
): Promise<IdmlPackageInspection> {
  const bytes = normalizeIdmlBytes(input)
  const limits = resolveIdmlLimits(requestedLimits)

  if (bytes.byteLength > limits.maxInputBytes) {
    fail("ARCHIVE_TOO_LARGE", "IDML archive exceeds the configured input size limit", undefined, {
      actualBytes: bytes.byteLength,
      maxBytes: limits.maxInputBytes,
    })
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = parseEndOfCentralDirectory(view)

  if (eocd.entryCount > limits.maxEntries) {
    fail("TOO_MANY_ENTRIES", "IDML archive exceeds the configured member count limit", undefined, {
      actualEntries: eocd.entryCount,
      maxEntries: limits.maxEntries,
    })
  }

  const centralMembers = parseCentralDirectory(bytes, view, eocd, limits)
  assertRequiredMembers(centralMembers)

  const localMembers = centralMembers.map((central) =>
    parseLocalMember(bytes, view, central, eocd.centralDirectoryOffset),
  )
  assertLocalLayout(localMembers, eocd.centralDirectoryOffset)
  assertMimetype(bytes, localMembers)

  return {
    format: "idml",
    mimetype: IDML_MIMETYPE,
    byteLength: bytes.byteLength,
    members: centralMembers.map(({ member }) => member),
    diagnostics: [],
  }
}

function assertNonNegativeIntegerLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "EXPORT_REJECTED",
      `IDML limit ${name} must be a non-negative safe integer`,
      undefined,
      { limit: name, value },
    )
  }
}

function parseEndOfCentralDirectory(view: DataView): EndOfCentralDirectory {
  if (view.byteLength < END_OF_CENTRAL_DIRECTORY_LENGTH) {
    fail("INVALID_ZIP", "IDML archive is too short to contain a ZIP end record")
  }

  const earliestOffset = Math.max(
    0,
    view.byteLength - END_OF_CENTRAL_DIRECTORY_LENGTH - MAX_ZIP_COMMENT_LENGTH,
  )
  let eocdOffset = -1

  for (
    let offset = view.byteLength - END_OF_CENTRAL_DIRECTORY_LENGTH;
    offset >= earliestOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue
    }
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + END_OF_CENTRAL_DIRECTORY_LENGTH + commentLength === view.byteLength) {
      eocdOffset = offset
      break
    }
  }

  if (eocdOffset < 0) {
    fail("INVALID_ZIP", "IDML archive has no valid ZIP end record")
  }

  if (
    (eocdOffset >= 20 &&
      view.getUint32(eocdOffset - 20, true) ===
        ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) ||
    (eocdOffset >= 4 &&
      view.getUint32(eocdOffset - 4, true) === ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  ) {
    fail("ZIP64_UNSUPPORTED", "ZIP64 IDML archives are not supported")
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true)
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)

  if (
    entriesOnDisk === UINT16_MAX ||
    entryCount === UINT16_MAX ||
    centralDirectorySize === UINT32_MAX ||
    centralDirectoryOffset === UINT32_MAX
  ) {
    fail("ZIP64_UNSUPPORTED", "ZIP64 sentinel values are not supported in IDML archives")
  }

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount
  ) {
    fail("INVALID_ZIP", "Multi-disk or inconsistent ZIP archives are not supported")
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (
    centralDirectoryEnd > eocdOffset ||
    centralDirectoryEnd < centralDirectoryOffset ||
    centralDirectoryEnd !== eocdOffset
  ) {
    fail("INVALID_ZIP", "ZIP central directory bounds do not match the end record")
  }

  return {
    entryCount,
    centralDirectoryOffset,
    centralDirectorySize,
  }
}

function parseCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
  eocd: EndOfCentralDirectory,
  limits: Readonly<IdmlLimits>,
): ParsedCentralMember[] {
  const members: ParsedCentralMember[] = []
  const normalizedPaths = new Set<string>()
  let totalUncompressedBytes = 0
  let offset = eocd.centralDirectoryOffset
  const endOffset = eocd.centralDirectoryOffset + eocd.centralDirectorySize

  for (let index = 0; index < eocd.entryCount; index += 1) {
    assertRange(
      offset,
      CENTRAL_DIRECTORY_HEADER_LENGTH,
      endOffset,
      "ZIP central directory header is truncated",
    )
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      fail("INVALID_ZIP", "ZIP central directory contains an invalid member signature", undefined, {
        entryIndex: index,
        offset,
      })
    }

    const flags = view.getUint16(offset + 8, true)
    const compressionMethod = view.getUint16(offset + 10, true)
    const crc32 = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const diskStart = view.getUint16(offset + 34, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const recordLength =
      CENTRAL_DIRECTORY_HEADER_LENGTH + nameLength + extraLength + commentLength

    assertRange(
      offset,
      recordLength,
      endOffset,
      "ZIP central directory member extends outside its declared bounds",
    )

    if (
      compressedSize === UINT32_MAX ||
      uncompressedSize === UINT32_MAX ||
      localHeaderOffset === UINT32_MAX ||
      diskStart === UINT16_MAX
    ) {
      fail("ZIP64_UNSUPPORTED", "ZIP64 member metadata is not supported")
    }
    if (diskStart !== 0) {
      fail("INVALID_ZIP", "Multi-disk ZIP members are not supported")
    }

    const rawName = bytes.subarray(
      offset + CENTRAL_DIRECTORY_HEADER_LENGTH,
      offset + CENTRAL_DIRECTORY_HEADER_LENGTH + nameLength,
    )
    const path = decodeMemberPath(rawName, (flags & UTF8_FLAG) !== 0)
    const normalizedPath = validateAndNormalizePath(path)
    const extraOffset = offset + CENTRAL_DIRECTORY_HEADER_LENGTH + nameLength
    validateExtraFields(bytes, view, extraOffset, extraLength, path)

    if (normalizedPaths.has(normalizedPath)) {
      fail("DUPLICATE_MEMBER", "IDML archive contains a duplicate normalized member path", path, {
        normalizedPath,
      })
    }
    normalizedPaths.add(normalizedPath)

    if ((flags & ENCRYPTION_FLAGS) !== 0) {
      fail("ENCRYPTED_MEMBER", "Encrypted ZIP members are not supported", path)
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      fail(
        "UNSUPPORTED_COMPRESSION",
        "IDML member uses an unsupported ZIP compression method",
        path,
        { compressionMethod },
      )
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      fail("INVALID_ZIP", "Stored ZIP member has inconsistent compressed and expanded sizes", path)
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      fail("ENTRY_TOO_LARGE", "IDML member exceeds the configured expanded size limit", path, {
        actualBytes: uncompressedSize,
        maxBytes: limits.maxEntryUncompressedBytes,
      })
    }

    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      fail(
        "EXPANSION_TOO_LARGE",
        "IDML archive exceeds the configured total expanded size limit",
        path,
        {
          actualBytes: totalUncompressedBytes,
          maxBytes: limits.maxTotalUncompressedBytes,
        },
      )
    }

    if (
      (compressedSize === 0 && uncompressedSize > 0) ||
      (compressedSize > 0 &&
        uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      fail(
        "COMPRESSION_RATIO_EXCEEDED",
        "IDML member exceeds the configured compression ratio limit",
        path,
        {
          compressedBytes: compressedSize,
          uncompressedBytes: uncompressedSize,
          maxRatio: limits.maxCompressionRatio,
        },
      )
    }

    const isDirectory = path.endsWith("/")
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      fail("INVALID_ZIP", "ZIP directory member must not contain file data", path)
    }
    if (localHeaderOffset >= eocd.centralDirectoryOffset) {
      fail("INVALID_ZIP", "ZIP member local header points outside the file-data region", path, {
        localHeaderOffset,
      })
    }

    members.push({
      member: {
        path,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        crc32,
        localHeaderOffset,
        isDirectory,
      },
      normalizedPath,
      flags,
      rawName,
      centralExtraLength: extraLength,
    })
    offset += recordLength
  }

  if (offset !== endOffset) {
    fail("INVALID_ZIP", "ZIP central directory member count does not match its byte length", undefined, {
      parsedBytes: offset - eocd.centralDirectoryOffset,
      declaredBytes: eocd.centralDirectorySize,
    })
  }

  return members
}

function assertRequiredMembers(members: readonly ParsedCentralMember[]): void {
  const mimetypeMembers = members.filter(({ normalizedPath }) => normalizedPath === "mimetype")
  if (mimetypeMembers.length === 0) {
    fail("INVALID_MIMETYPE", "IDML archive is missing its root mimetype member")
  }
  if (mimetypeMembers.length > 1) {
    fail("DUPLICATE_MEMBER", "IDML archive contains duplicate root mimetype members", "mimetype")
  }

  const designmapMembers = members.filter(
    ({ normalizedPath }) => normalizedPath === "designmap.xml",
  )
  if (designmapMembers.length === 0) {
    fail("MISSING_DESIGNMAP", "IDML archive is missing its root designmap.xml member")
  }
  if (designmapMembers.length > 1) {
    fail(
      "DUPLICATE_MEMBER",
      "IDML archive contains duplicate root designmap.xml members",
      "designmap.xml",
    )
  }
}

function parseLocalMember(
  bytes: Uint8Array,
  view: DataView,
  central: ParsedCentralMember,
  centralDirectoryOffset: number,
): ParsedLocalMember {
  const { member } = central
  const offset = member.localHeaderOffset
  assertRange(
    offset,
    LOCAL_FILE_HEADER_LENGTH,
    centralDirectoryOffset,
    "ZIP local member header is truncated",
    member.path,
  )
  if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    fail("INVALID_ZIP", "ZIP member has an invalid local header signature", member.path, {
      localHeaderOffset: offset,
    })
  }

  const flags = view.getUint16(offset + 6, true)
  const compressionMethod = view.getUint16(offset + 8, true)
  const localCrc32 = view.getUint32(offset + 14, true)
  const localCompressedSize = view.getUint32(offset + 18, true)
  const localUncompressedSize = view.getUint32(offset + 22, true)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const variableHeaderLength = LOCAL_FILE_HEADER_LENGTH + nameLength + extraLength

  assertRange(
    offset,
    variableHeaderLength,
    centralDirectoryOffset,
    "ZIP local member name or extra field is truncated",
    member.path,
  )
  if (
    localCompressedSize === UINT32_MAX ||
    localUncompressedSize === UINT32_MAX
  ) {
    fail("ZIP64_UNSUPPORTED", "ZIP64 local member metadata is not supported", member.path)
  }
  if (flags !== central.flags) {
    fail("INVALID_ZIP", "ZIP central and local member flags do not match", member.path)
  }
  if ((flags & ENCRYPTION_FLAGS) !== 0) {
    fail("ENCRYPTED_MEMBER", "Encrypted ZIP members are not supported", member.path)
  }
  if (compressionMethod !== member.compressionMethod) {
    fail("INVALID_ZIP", "ZIP central and local compression methods do not match", member.path)
  }

  const localRawName = bytes.subarray(
    offset + LOCAL_FILE_HEADER_LENGTH,
    offset + LOCAL_FILE_HEADER_LENGTH + nameLength,
  )
  if (!bytesEqual(localRawName, central.rawName)) {
    fail("INVALID_ZIP", "ZIP central and local member names do not match", member.path)
  }

  const extraOffset = offset + LOCAL_FILE_HEADER_LENGTH + nameLength
  validateExtraFields(bytes, view, extraOffset, extraLength, member.path)

  const usesDataDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0
  if (usesDataDescriptor) {
    if (
      (localCrc32 !== 0 && localCrc32 !== member.crc32) ||
      (localCompressedSize !== 0 && localCompressedSize !== member.compressedSize) ||
      (localUncompressedSize !== 0 &&
        localUncompressedSize !== member.uncompressedSize)
    ) {
      fail(
        "INVALID_ZIP",
        "ZIP data-descriptor member has conflicting local size or checksum metadata",
        member.path,
      )
    }
  } else if (
    localCrc32 !== member.crc32 ||
    localCompressedSize !== member.compressedSize ||
    localUncompressedSize !== member.uncompressedSize
  ) {
    fail(
      "INVALID_ZIP",
      "ZIP central and local member size or checksum metadata do not match",
      member.path,
    )
  }

  const dataOffset = offset + variableHeaderLength
  const dataEnd = dataOffset + member.compressedSize
  if (
    dataEnd < dataOffset ||
    dataEnd > centralDirectoryOffset ||
    dataEnd > bytes.byteLength
  ) {
    fail("INVALID_ZIP", "ZIP member payload extends outside the file-data region", member.path)
  }

  const endOffset = usesDataDescriptor
    ? parseDataDescriptor(view, dataEnd, centralDirectoryOffset, member)
    : dataEnd

  return {
    central,
    dataOffset,
    endOffset,
    localExtraLength: extraLength,
  }
}

function parseDataDescriptor(
  view: DataView,
  offset: number,
  limit: number,
  member: IdmlArchiveMember,
): number {
  assertRange(offset, 12, limit, "ZIP data descriptor is truncated", member.path)

  const firstWord = view.getUint32(offset, true)
  const unsignedValid =
    firstWord === member.crc32 &&
    view.getUint32(offset + 4, true) === member.compressedSize &&
    view.getUint32(offset + 8, true) === member.uncompressedSize

  if (firstWord !== DATA_DESCRIPTOR_SIGNATURE) {
    if (!unsignedValid) {
      fail("INVALID_ZIP", "ZIP data descriptor does not match central metadata", member.path)
    }
    return offset + 12
  }

  let signedValid = false
  if (offset + 16 <= limit) {
    signedValid =
      view.getUint32(offset + 4, true) === member.crc32 &&
      view.getUint32(offset + 8, true) === member.compressedSize &&
      view.getUint32(offset + 12, true) === member.uncompressedSize
  }

  if (unsignedValid || !signedValid) {
    fail(
      "INVALID_ZIP",
      "ZIP data descriptor is ambiguous or does not match central metadata",
      member.path,
    )
  }
  return offset + 16
}

function assertLocalLayout(
  localMembers: readonly ParsedLocalMember[],
  centralDirectoryOffset: number,
): void {
  const ordered = [...localMembers].sort(
    (left, right) =>
      left.central.member.localHeaderOffset - right.central.member.localHeaderOffset,
  )

  if (ordered.length === 0) {
    fail("INVALID_MIMETYPE", "IDML archive contains no members")
  }

  let expectedOffset = 0
  for (const local of ordered) {
    const actualOffset = local.central.member.localHeaderOffset
    if (actualOffset !== expectedOffset) {
      fail(
        "INVALID_ZIP",
        "ZIP local members are overlapping, hidden, duplicated, or separated by untracked data",
        local.central.member.path,
        { actualOffset, expectedOffset },
      )
    }
    expectedOffset = local.endOffset
  }

  if (expectedOffset !== centralDirectoryOffset) {
    fail(
      "INVALID_ZIP",
      "ZIP file-data region contains data not described by the central directory",
      undefined,
      { actualEnd: expectedOffset, expectedEnd: centralDirectoryOffset },
    )
  }
}

function assertMimetype(bytes: Uint8Array, localMembers: readonly ParsedLocalMember[]): void {
  const first = [...localMembers].sort(
    (left, right) =>
      left.central.member.localHeaderOffset - right.central.member.localHeaderOffset,
  )[0]
  if (!first || first.central.normalizedPath !== "mimetype") {
    fail("INVALID_UCF_ORDER", "The first local IDML archive member must be exactly mimetype")
  }

  const { member } = first.central
  if (
    member.compressionMethod !== 0 ||
    first.localExtraLength !== 0 ||
    first.central.centralExtraLength !== 0
  ) {
    fail(
      "INVALID_MIMETYPE",
      "The IDML mimetype member must be stored without local or central extra fields",
      member.path,
    )
  }
  if (
    member.compressedSize !== IDML_MIMETYPE_BYTES.byteLength ||
    member.uncompressedSize !== IDML_MIMETYPE_BYTES.byteLength
  ) {
    fail("INVALID_MIMETYPE", "The IDML mimetype member has an invalid byte length", member.path)
  }

  const payload = bytes.subarray(
    first.dataOffset,
    first.dataOffset + member.compressedSize,
  )
  if (!bytesEqual(payload, IDML_MIMETYPE_BYTES)) {
    fail("INVALID_MIMETYPE", "The IDML mimetype member has invalid content", member.path)
  }
}

function validateExtraFields(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  length: number,
  memberPath: string,
): void {
  const endOffset = offset + length
  if (endOffset > bytes.byteLength || endOffset < offset) {
    fail("INVALID_ZIP", "ZIP extra fields extend outside the archive", memberPath)
  }

  let cursor = offset
  while (cursor < endOffset) {
    if (endOffset - cursor < 4) {
      fail("INVALID_ZIP", "ZIP member has a truncated extra-field header", memberPath)
    }
    const fieldId = view.getUint16(cursor, true)
    const fieldLength = view.getUint16(cursor + 2, true)
    cursor += 4
    if (cursor + fieldLength > endOffset || cursor + fieldLength < cursor) {
      fail("INVALID_ZIP", "ZIP member has a truncated extra-field payload", memberPath)
    }
    if (fieldId === ZIP64_EXTRA_FIELD_ID) {
      fail("ZIP64_UNSUPPORTED", "ZIP64 member extra fields are not supported", memberPath)
    }
    cursor += fieldLength
  }
}

function decodeMemberPath(rawName: Uint8Array, isUtf8: boolean): string {
  if (isUtf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(rawName)
    } catch {
      fail("INVALID_ZIP", "ZIP member name is not valid UTF-8")
    }
  }

  let result = ""
  for (const byte of rawName) {
    if (byte < 0x80) {
      result += String.fromCharCode(byte)
      continue
    }
    const character = CP437_HIGH_CHARACTERS[byte - 0x80]
    if (!character) {
      fail("INVALID_ZIP", "ZIP member name contains an undecodable CP437 byte")
    }
    result += character
  }
  return result
}

function validateAndNormalizePath(path: string): string {
  const normalizedPath = path.normalize("NFC")
  const hasAbsolutePrefix =
    normalizedPath.startsWith("/") || /^[A-Za-z]:($|\/)/u.test(normalizedPath)
  const components = normalizedPath.split("/")
  const isDirectory = normalizedPath.endsWith("/")
  const componentsToValidate = isDirectory ? components.slice(0, -1) : components

  if (
    normalizedPath.length === 0 ||
    normalizedPath.includes("\0") ||
    normalizedPath.includes("\\") ||
    hasAbsolutePrefix ||
    componentsToValidate.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    fail("UNSAFE_MEMBER_PATH", "IDML archive contains an unsafe member path", path)
  }

  return normalizedPath
}

function assertRange(
  offset: number,
  length: number,
  limit: number,
  message: string,
  memberPath?: string,
): void {
  const endOffset = offset + length
  if (
    offset < 0 ||
    length < 0 ||
    endOffset < offset ||
    endOffset > limit
  ) {
    fail("INVALID_ZIP", message, memberPath, { offset, length, limit })
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

function fail(
  code: IdmlDiagnosticCode,
  message: string,
  memberPath?: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  const diagnostic = {
    code,
    severity: "error" as const,
    message,
    ...(memberPath === undefined ? {} : { memberPath }),
    ...(details === undefined ? {} : { details }),
  }
  throw new IdmlError(code, message, [diagnostic])
}
