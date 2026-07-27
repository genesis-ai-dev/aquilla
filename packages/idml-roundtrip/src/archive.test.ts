import { describe, expect, it } from "vitest"

import { DEFAULT_IDML_LIMITS, inspectIdml } from "./archive.js"
import type { IdmlDiagnosticCode } from "./types.js"

const MIMETYPE = "application/vnd.adobe.indesign-idml-package"
const textEncoder = new TextEncoder()

interface TestZipEntry {
  readonly name: string
  readonly data?: string | Uint8Array
  readonly compressedData?: Uint8Array
  readonly compressionMethod?: number
  readonly flags?: number
  readonly crc32?: number
  readonly uncompressedSize?: number
  readonly localExtra?: Uint8Array
  readonly centralExtra?: Uint8Array
  readonly centralLocalHeaderOffset?: number
  readonly dataDescriptor?: "signed" | "unsigned"
}

interface PreparedTestZipEntry {
  readonly options: TestZipEntry
  readonly name: Uint8Array
  readonly compressedData: Uint8Array
  readonly compressionMethod: number
  readonly flags: number
  readonly crc32: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

function idmlEntries(additional: readonly TestZipEntry[] = []): TestZipEntry[] {
  return [
    { name: "mimetype", data: MIMETYPE },
    { name: "designmap.xml", data: "<Document/>" },
    ...additional,
  ]
}

function makeZip(
  entries: readonly TestZipEntry[],
  options: { readonly centralOrder?: readonly number[] } = {},
): Uint8Array {
  const localChunks: Uint8Array[] = []
  const prepared: PreparedTestZipEntry[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = textEncoder.encode(entry.name)
    const data = typeof entry.data === "string"
      ? textEncoder.encode(entry.data)
      : entry.data ?? new Uint8Array()
    const compressedData = entry.compressedData ?? data
    const compressionMethod = entry.compressionMethod ?? 0
    const flags = entry.flags ?? 0x0800
    const checksum = entry.crc32 ?? crc32(data)
    const uncompressedSize = entry.uncompressedSize ?? data.byteLength
    const localExtra = entry.localExtra ?? new Uint8Array()
    const usesDescriptor = entry.dataDescriptor !== undefined
    const localHeader = new Uint8Array(30 + name.byteLength + localExtra.byteLength)
    const localView = new DataView(localHeader.buffer)

    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, usesDescriptor ? flags | 0x0008 : flags, true)
    localView.setUint16(8, compressionMethod, true)
    localView.setUint32(14, usesDescriptor ? 0 : checksum, true)
    localView.setUint32(18, usesDescriptor ? 0 : compressedData.byteLength, true)
    localView.setUint32(22, usesDescriptor ? 0 : uncompressedSize, true)
    localView.setUint16(26, name.byteLength, true)
    localView.setUint16(28, localExtra.byteLength, true)
    localHeader.set(name, 30)
    localHeader.set(localExtra, 30 + name.byteLength)

    const descriptor = entry.dataDescriptor
      ? makeDataDescriptor(
          entry.dataDescriptor,
          checksum,
          compressedData.byteLength,
          uncompressedSize,
        )
      : new Uint8Array()

    localChunks.push(localHeader, compressedData, descriptor)
    prepared.push({
      options: entry,
      name,
      compressedData,
      compressionMethod,
      flags: usesDescriptor ? flags | 0x0008 : flags,
      crc32: checksum,
      uncompressedSize,
      localOffset,
    })
    localOffset += localHeader.byteLength + compressedData.byteLength + descriptor.byteLength
  }

  const centralOrder = options.centralOrder ?? entries.map((_, index) => index)
  const centralChunks: Uint8Array[] = []
  for (const entryIndex of centralOrder) {
    const entry = prepared[entryIndex]
    if (!entry) {
      throw new Error(`Invalid central-order test index ${entryIndex}`)
    }
    const centralExtra = entry.options.centralExtra ?? new Uint8Array()
    const centralHeader = new Uint8Array(46 + entry.name.byteLength + centralExtra.byteLength)
    const centralView = new DataView(centralHeader.buffer)

    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, entry.flags, true)
    centralView.setUint16(10, entry.compressionMethod, true)
    centralView.setUint32(16, entry.crc32, true)
    centralView.setUint32(20, entry.compressedData.byteLength, true)
    centralView.setUint32(24, entry.uncompressedSize, true)
    centralView.setUint16(28, entry.name.byteLength, true)
    centralView.setUint16(30, centralExtra.byteLength, true)
    centralView.setUint32(
      42,
      entry.options.centralLocalHeaderOffset ?? entry.localOffset,
      true,
    )
    centralHeader.set(entry.name, 46)
    centralHeader.set(centralExtra, 46 + entry.name.byteLength)
    centralChunks.push(centralHeader)
  }

  const centralDirectory = concatenate(centralChunks)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, centralOrder.length, true)
  eocdView.setUint16(10, centralOrder.length, true)
  eocdView.setUint32(12, centralDirectory.byteLength, true)
  eocdView.setUint32(16, localOffset, true)

  return concatenate([...localChunks, centralDirectory, eocd])
}

function makeDataDescriptor(
  kind: "signed" | "unsigned",
  checksum: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  const descriptor = new Uint8Array(kind === "signed" ? 16 : 12)
  const view = new DataView(descriptor.buffer)
  let offset = 0
  if (kind === "signed") {
    view.setUint32(offset, 0x08074b50, true)
    offset += 4
  }
  view.setUint32(offset, checksum, true)
  view.setUint32(offset + 4, compressedSize, true)
  view.setUint32(offset + 8, uncompressedSize, true)
  return descriptor
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0)
    }
  }
  return (checksum ^ 0xffffffff) >>> 0
}

async function expectIdmlError(
  archive: Uint8Array | ArrayBuffer,
  code: IdmlDiagnosticCode,
  limits?: Parameters<typeof inspectIdml>[1],
): Promise<void> {
  await expect(inspectIdml(archive, limits)).rejects.toMatchObject({
    name: "IdmlError",
    code,
    diagnostics: [{ code, severity: "error" }],
  })
}

describe("inspectIdml", () => {
  it("uses browser-safe default expansion limits", () => {
    expect(DEFAULT_IDML_LIMITS).toEqual({
      maxInputBytes: 128 * 1024 * 1024,
      maxEntries: 10_000,
      maxEntryUncompressedBytes: 64 * 1024 * 1024,
      maxTotalUncompressedBytes: 512 * 1024 * 1024,
      maxCompressionRatio: 200,
    })
  })

  it("accepts a valid UCF package and preserves central-directory order", async () => {
    const archive = makeZip(idmlEntries(), { centralOrder: [1, 0] })

    const inspection = await inspectIdml(archive)

    expect(inspection).toMatchObject({
      format: "idml",
      mimetype: MIMETYPE,
      byteLength: archive.byteLength,
      diagnostics: [],
    })
    expect(inspection.members.map((member) => member.path)).toEqual([
      "designmap.xml",
      "mimetype",
    ])
  })

  it("honors Uint8Array offsets and sliced ArrayBuffers", async () => {
    const archive = makeZip(idmlEntries())
    const padded = new Uint8Array(archive.byteLength + 12)
    padded.set(archive, 5)
    const view = padded.subarray(5, 5 + archive.byteLength)
    const slicedBuffer = padded.buffer.slice(5, 5 + archive.byteLength)

    await expect(inspectIdml(view)).resolves.toMatchObject({ byteLength: archive.byteLength })
    await expect(inspectIdml(slicedBuffer)).resolves.toMatchObject({
      byteLength: archive.byteLength,
    })
  })

  it("accepts an unambiguous signed data descriptor", async () => {
    const archive = makeZip([
      { name: "mimetype", data: MIMETYPE },
      { name: "designmap.xml", data: "<Document/>", dataDescriptor: "signed" },
    ])

    await expect(inspectIdml(archive)).resolves.toMatchObject({ format: "idml" })
  })

  it("rejects corrupt local and end-of-central-directory signatures", async () => {
    const badLocal = makeZip(idmlEntries())
    new DataView(badLocal.buffer).setUint32(0, 0x12345678, true)
    await expectIdmlError(badLocal, "INVALID_ZIP")

    const badEocd = makeZip(idmlEntries())
    new DataView(badEocd.buffer).setUint32(badEocd.byteLength - 22, 0x12345678, true)
    await expectIdmlError(badEocd, "INVALID_ZIP")
  })

  it("rejects an EOCD whose declared comment is truncated", async () => {
    const archive = makeZip(idmlEntries())
    new DataView(archive.buffer).setUint16(archive.byteLength - 2, 1, true)

    await expectIdmlError(archive, "INVALID_ZIP")
  })

  it("requires mimetype to be the first physical member", async () => {
    const archive = makeZip([
      { name: "designmap.xml", data: "<Document/>" },
      { name: "mimetype", data: MIMETYPE },
    ])

    await expectIdmlError(archive, "INVALID_UCF_ORDER")
  })

  it("requires mimetype to be stored, exact, and free of extra fields", async () => {
    await expectIdmlError(
      makeZip([
        {
          name: "mimetype",
          data: MIMETYPE,
          compressedData: textEncoder.encode(MIMETYPE),
          compressionMethod: 8,
        },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "INVALID_MIMETYPE",
    )

    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: `${MIMETYPE.slice(0, -1)}x` },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "INVALID_MIMETYPE",
    )

    await expectIdmlError(
      makeZip([
        {
          name: "mimetype",
          data: MIMETYPE,
          localExtra: new Uint8Array([0xfe, 0xca, 0, 0]),
        },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "INVALID_MIMETYPE",
    )

    await expectIdmlError(
      makeZip([
        {
          name: "mimetype",
          data: MIMETYPE,
          centralExtra: new Uint8Array([0xfe, 0xca, 0, 0]),
        },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "INVALID_MIMETYPE",
    )
  })

  it("requires exactly one root designmap.xml and one mimetype", async () => {
    await expectIdmlError(
      makeZip([{ name: "mimetype", data: MIMETYPE }]),
      "MISSING_DESIGNMAP",
    )
    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        { name: "designmap.xml", data: "<Document/>" },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "DUPLICATE_MEMBER",
    )
    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        { name: "mimetype", data: MIMETYPE },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "DUPLICATE_MEMBER",
    )
  })

  it.each([
    "../Stories/Story.xml",
    "/Stories/Story.xml",
    "C:/Stories/Story.xml",
    "Stories\\Story.xml",
    "Stories/\0Story.xml",
    "Stories//Story.xml",
    "Stories/./Story.xml",
  ])("rejects unsafe member path %j", async (path) => {
    await expectIdmlError(
      makeZip(idmlEntries([{ name: path, data: "unsafe" }])),
      "UNSAFE_MEMBER_PATH",
    )
  })

  it("rejects duplicate Unicode-normalized paths", async () => {
    await expectIdmlError(
      makeZip(
        idmlEntries([
          { name: "Stories/café.xml", data: "one" },
          { name: "Stories/cafe\u0301.xml", data: "two" },
        ]),
      ),
      "DUPLICATE_MEMBER",
    )
  })

  it("rejects encrypted and unsupported-compression members", async () => {
    await expectIdmlError(
      makeZip(idmlEntries([{ name: "Stories/a.xml", data: "secret", flags: 0x0801 }])),
      "ENCRYPTED_MEMBER",
    )
    await expectIdmlError(
      makeZip(
        idmlEntries([
          { name: "Stories/a.xml", data: "compressed", compressionMethod: 12 },
        ]),
      ),
      "UNSUPPORTED_COMPRESSION",
    )
  })

  it("enforces input, member-count, member-size, and total-expansion limits", async () => {
    const archive = makeZip(idmlEntries())
    await expectIdmlError(archive, "ARCHIVE_TOO_LARGE", {
      maxInputBytes: archive.byteLength - 1,
    })
    await expectIdmlError(archive, "TOO_MANY_ENTRIES", { maxEntries: 1 })

    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        {
          name: "designmap.xml",
          data: "expanded",
          compressedData: new Uint8Array([1]),
          compressionMethod: 8,
          uncompressedSize: 100,
        },
      ]),
      "ENTRY_TOO_LARGE",
      { maxEntryUncompressedBytes: 50 },
    )

    await expectIdmlError(archive, "EXPANSION_TOO_LARGE", {
      maxTotalUncompressedBytes: textEncoder.encode(MIMETYPE).byteLength,
    })
  })

  it("rejects excessive and infinite declared compression ratios", async () => {
    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        {
          name: "designmap.xml",
          data: "x",
          compressedData: new Uint8Array([1]),
          compressionMethod: 8,
          uncompressedSize: 100,
        },
      ]),
      "COMPRESSION_RATIO_EXCEEDED",
      { maxCompressionRatio: 10 },
    )

    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        {
          name: "designmap.xml",
          data: "x",
          compressedData: new Uint8Array(),
          compressionMethod: 8,
          uncompressedSize: 1,
        },
      ]),
      "COMPRESSION_RATIO_EXCEEDED",
    )
  })

  it("rejects ZIP64 sentinel metadata and ZIP64 extra fields", async () => {
    const sentinelArchive = makeZip(idmlEntries())
    const sentinelView = new DataView(sentinelArchive.buffer)
    sentinelView.setUint16(sentinelArchive.byteLength - 22 + 10, 0xffff, true)
    await expectIdmlError(sentinelArchive, "ZIP64_UNSUPPORTED")

    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        {
          name: "designmap.xml",
          data: "<Document/>",
          centralExtra: new Uint8Array([1, 0, 0, 0]),
        },
      ]),
      "ZIP64_UNSUPPORTED",
    )

    const baseArchive = makeZip(idmlEntries())
    const zip64Locator = new Uint8Array(20)
    new DataView(zip64Locator.buffer).setUint32(0, 0x07064b50, true)
    const locatorArchive = concatenate([
      baseArchive.subarray(0, baseArchive.byteLength - 22),
      zip64Locator,
      baseArchive.subarray(baseArchive.byteLength - 22),
    ])
    await expectIdmlError(locatorArchive, "ZIP64_UNSUPPORTED")
  })

  it("rejects malformed local offsets and untracked gaps", async () => {
    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE, centralLocalHeaderOffset: 1 },
        { name: "designmap.xml", data: "<Document/>" },
      ]),
      "INVALID_ZIP",
    )
  })

  it("rejects ambiguous unsigned data descriptors", async () => {
    await expectIdmlError(
      makeZip([
        { name: "mimetype", data: MIMETYPE },
        {
          name: "designmap.xml",
          data: "<Document/>",
          crc32: 0x08074b50,
          dataDescriptor: "unsigned",
        },
      ]),
      "INVALID_ZIP",
    )
  })
})
