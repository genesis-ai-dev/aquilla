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

  it("rejects an extreme aggregate compression ratio", () => {
    expect(() => assertSafeZipArchive(fakeArchive([
      { name: "word/document.xml", compressed: 100, uncompressed: 100_001 },
    ]), "DOCX file")).toThrow(/unsafe compression ratio/i)
  })
})

