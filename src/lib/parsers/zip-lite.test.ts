import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { readZipLite, readZipLiteEntryBytes, readZipLiteEntryText } from "./zip-lite"
import { assertSafeZipLiteArchive, isUnsafeArchivePath } from "./zip-safety"
import { buildDocxParityFixture } from "./__fixtures__/docx-parity"

/** JSZip is the writer the SPA's own tests use, so reading its output is the
 *  real interop check — it emits DEFLATE members and a data descriptor. */
async function jszipArchive(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }))
}

describe("readZipLite", () => {
  it("reads DEFLATE members written by JSZip", async () => {
    // Long enough that JSZip actually compresses rather than storing it.
    const long = "the quick brown fox jumps over the lazy dog. ".repeat(40)
    const bytes = await jszipArchive({ "a/one.txt": long, "b/two.txt": "second" })
    const archive = readZipLite(bytes)

    // JSZip records the implied directories too; they are flagged, not files.
    expect(archive.entries.filter((e) => !e.isDirectory).map((e) => e.name).sort()).toEqual([
      "a/one.txt",
      "b/two.txt",
    ])
    expect(archive.entries.filter((e) => e.isDirectory).map((e) => e.name).sort()).toEqual(["a/", "b/"])
    expect(await readZipLiteEntryText(archive, "a/one.txt")).toBe(long)
    expect(await readZipLiteEntryText(archive, "b/two.txt")).toBe("second")
  })

  it("reads STORED members", async () => {
    // The parity fixture is a hand-written stored-only archive.
    const archive = readZipLite(buildDocxParityFixture())
    const document = await readZipLiteEntryText(archive, "word/document.xml")
    expect(document).toContain("<w:t>Field Guide</w:t>")
    expect(archive.byName.get("word/document.xml")!.compressionMethod).toBe(0)
  })

  it("accepts a Uint8Array or an ArrayBuffer", async () => {
    const bytes = await jszipArchive({ "x.txt": "hello" })
    expect(readZipLite(bytes).entries).toHaveLength(1)
    expect(readZipLite(bytes.buffer as ArrayBuffer).entries).toHaveLength(1)
  })

  it("decodes UTF-8 and strips a BOM", async () => {
    const bytes = await jszipArchive({ "x.txt": "\ufeffnaïve — text" })
    const archive = readZipLite(bytes)
    expect(await readZipLiteEntryText(archive, "x.txt")).toBe("naïve — text")
  })

  it("returns null for a member the archive does not contain", async () => {
    const archive = readZipLite(await jszipArchive({ "x.txt": "hello" }))
    expect(await readZipLiteEntryBytes(archive, "word/document.xml")).toBeNull()
    expect(await readZipLiteEntryText(archive, "word/document.xml")).toBeNull()
  })

  it("rejects bytes that are not a ZIP archive", () => {
    expect(() => readZipLite(new TextEncoder().encode("plain text, not a zip"))).toThrow(
      /not a zip archive/i,
    )
  })

  it("rejects an archive truncated after its central directory offset", async () => {
    const bytes = await jszipArchive({ "x.txt": "hello" })
    // Keep the EOCD (so it is still found) but corrupt where it points.
    const corrupted = bytes.slice()
    const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength)
    view.setUint32(corrupted.length - 22 + 16, corrupted.length + 1000, true)
    expect(() => readZipLite(corrupted)).toThrow(/out of range/i)
  })
})

describe("assertSafeZipLiteArchive", () => {
  it("passes a normal archive", async () => {
    const archive = readZipLite(await jszipArchive({ "word/document.xml": "<a/>" }))
    expect(() => assertSafeZipLiteArchive(archive, "DOCX file")).not.toThrow()
  })

  it("rejects traversal, absolute, and backslash paths", () => {
    expect(isUnsafeArchivePath("word/document.xml")).toBe(false)
    expect(isUnsafeArchivePath("a/../../etc/passwd")).toBe(true)
    expect(isUnsafeArchivePath("/etc/passwd")).toBe(true)
    expect(isUnsafeArchivePath("C:\\Windows\\system32")).toBe(true)
    expect(isUnsafeArchivePath("word\\document.xml")).toBe(true)
    // A name that merely CONTAINS dots is fine — only a whole `..` segment is traversal.
    expect(isUnsafeArchivePath("word/..document.xml")).toBe(false)
  })

  it("rejects a declared-size zip bomb before anything is inflated", async () => {
    const archive = readZipLite(await jszipArchive({ "bomb.bin": "x" }))
    const entry = archive.entries[0]
    entry.compressedSize = 1_000
    entry.uncompressedSize = 900_000_000
    expect(() => assertSafeZipLiteArchive(archive, "DOCX file")).toThrow(/128 MB/)
  })

  it("rejects an unsafe compression ratio", async () => {
    const archive = readZipLite(await jszipArchive({ "a.bin": "x", "b.bin": "y" }))
    for (const entry of archive.entries) {
      entry.compressedSize = 10
      entry.uncompressedSize = 50_000
    }
    expect(() => assertSafeZipLiteArchive(archive, "DOCX file")).toThrow(/compression ratio/)
  })
})
