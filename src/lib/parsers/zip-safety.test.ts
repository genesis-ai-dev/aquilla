import { describe, expect, it } from "vitest"
import type JSZip from "jszip"
import { assertSafeZipArchive } from "./zip-safety"

function fakeArchive(entries: Array<{
  name: string
  compressed: number
  uncompressed: number
  unsafeOriginalName?: string
}>): JSZip {
  return {
    files: Object.fromEntries(entries.map((entry) => [entry.name, {
      dir: false,
      name: entry.name,
      ...(entry.unsafeOriginalName ? { unsafeOriginalName: entry.unsafeOriginalName } : {}),
      _data: { compressedSize: entry.compressed, uncompressedSize: entry.uncompressed },
    }])),
  } as unknown as JSZip
}

describe("assertSafeZipArchive", () => {
  it("accepts ordinary loaded archive metadata", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "word/document.xml", compressed: 100, uncompressed: 300 },
    ]), "DOCX file")).not.toThrow()
  })

  it("rejects an unsafe path before reading a member", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "evil.txt", unsafeOriginalName: "../../evil.txt", compressed: 10, uncompressed: 10 },
    ]), "archive")).toThrow(/unsafe archive path/i)
  })

  it("rejects extreme expansion before reading a member", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "xl/worksheets/sheet1.xml", compressed: 1, uncompressed: 129 * 1024 * 1024 },
    ]), "XLSX workbook")).toThrow(/larger than 128 MB/i)
  })

  // AQU-1406: a Paratext export can carry a PTXprint helper whose size header
  // is unreadable. A member the importer never reads must not fail the archive.
  it("skips an optional entry with unreadable size metadata instead of failing", () => {
    const report = assertSafeZipArchive(fakeArchive([
      { name: "01GEN.SFM", compressed: 100, uncompressed: 300 },
      {
        name: "shared/ptxprint/Default/FRTlocal.sfm",
        compressed: 10,
        uncompressed: undefined as unknown as number,
      },
    ]), "Paratext ZIP", { isOptionalEntry: (name) => name.startsWith("shared/ptxprint/") })

    expect(report.skipped).toEqual(["shared/ptxprint/Default/FRTlocal.sfm"])
  })

  it("still fails when a required entry has unreadable size metadata", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "44ACTSibtatar.SFM", compressed: 10, uncompressed: undefined as unknown as number },
    ]), "Paratext ZIP", { isOptionalEntry: (name) => name.startsWith("shared/ptxprint/") }))
      .toThrow(/invalid size metadata: 44ACTSibtatar\.SFM/)
  })

  it("reports no skips and keeps every entry when all metadata is readable", () => {
    const report = assertSafeZipArchive(fakeArchive([
      { name: "01GEN.SFM", compressed: 100, uncompressed: 300 },
      { name: "Settings.xml", compressed: 10, uncompressed: 20 },
    ]), "Paratext ZIP", { isOptionalEntry: () => true })

    expect(report.skipped).toEqual([])
  })

  it("rejects an unsafe path even when the entry is optional", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "evil.txt", unsafeOriginalName: "../../evil.txt", compressed: 10, uncompressed: 10 },
    ]), "Paratext ZIP", { isOptionalEntry: () => true })).toThrow(/unsafe archive path/i)
  })

  it("rejects an extreme aggregate compression ratio", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "word/document.xml", compressed: 100, uncompressed: 100_001 },
    ]), "DOCX file")).toThrow(/unsafe compression ratio/i)
  })
})

