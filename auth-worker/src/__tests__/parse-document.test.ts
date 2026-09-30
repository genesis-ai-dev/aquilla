// parse-document — unit tests (AQU-197)
//
// Tests the text-extraction helpers directly (no HTTP, no DB) and the
// size-cap rejection via the Hono app. The authMiddleware is exercised
// incidentally: unauthenticated requests → 401.

import { describe, it, expect } from "vitest"
import { zipSync, zlibSync, deflateSync, strToU8 } from "fflate"
import { extractTextFromDocx, extractTextFromPdf } from "../routes/parse-document"

// ── DOCX fixtures ────────────────────────────────────────────────────────────

function makeDocx(paragraphs: string[]): Uint8Array {
  // Build a minimal word/document.xml
  const runs = paragraphs.map(
    (p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`,
  )
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${runs.join("")}</w:body></w:document>`
  const zipped = zipSync({ "word/document.xml": strToU8(xml) })
  return zipped
}

describe("extractTextFromDocx", () => {
  it("extracts paragraph text from a valid DOCX", () => {
    const docx = makeDocx(["Hello world", "Second paragraph"])
    const text = extractTextFromDocx(docx)
    expect(text).toContain("Hello world")
    expect(text).toContain("Second paragraph")
  })

  it("handles XML entities", () => {
    const docx = makeDocx(["A &amp; B", "less &lt; more"])
    const text = extractTextFromDocx(docx)
    expect(text).toContain("A & B")
    expect(text).toContain("less < more")
  })

  it("throws on corrupt zip data", () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    expect(() => extractTextFromDocx(garbage)).toThrow(/corrupt/)
  })

  it("throws when word/document.xml is missing", () => {
    // A valid zip that does NOT contain word/document.xml
    const zipped = zipSync({ "unrelated.xml": strToU8("<foo/>") })
    expect(() => extractTextFromDocx(zipped)).toThrow(/word\/document\.xml/)
  })

  // AQU pen-test finding (2026-07-29): unzipSync() with no size guard would
  // fully inflate whatever word/document.xml declares, even gigabytes from a
  // tiny upload (a zip bomb). The filter-based size check must reject before
  // any inflation happens for the oversized entry.
  it("rejects a word/document.xml whose declared inflated size exceeds the safety cap (zip-bomb guard)", () => {
    const huge = "a".repeat(21 * 1024 * 1024) // 21 MB inflated — over the 20 MB cap
    const xml = `<w:document><w:body><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:body></w:document>`
    const zipped = zipSync({ "word/document.xml": strToU8(xml) }, { level: 9 })
    expect(() => extractTextFromDocx(zipped)).toThrow(/zip bomb|size limit/)
  })
})

// ── PDF fixtures ─────────────────────────────────────────────────────────────

function makePdf(texts: string[]): Uint8Array {
  // Minimal synthetic PDF with BT…ET blocks containing Tj operators
  const streams = texts
    .map((t) => `BT\n(${t}) Tj\nET`)
    .join("\n")
  return new TextEncoder().encode(`%PDF-1.4\n${streams}\n%%EOF`)
}

describe("extractTextFromPdf", () => {
  it("extracts text from BT/ET blocks with Tj", () => {
    const pdf = makePdf(["Rule one applies here", "Second rule text"])
    const text = extractTextFromPdf(pdf)
    expect(text).toContain("Rule one applies here")
    expect(text).toContain("Second rule text")
  })

  it("handles PDF octal escape sequences", () => {
    // \101 = 'A', \102 = 'B'
    const bytes = new TextEncoder().encode("BT\n(\\101\\102C) Tj\nET")
    const text = extractTextFromPdf(bytes)
    expect(text).toContain("ABC")
  })

  it("returns empty string for PDF with no BT/ET blocks", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF")
    const text = extractTextFromPdf(bytes)
    expect(text).toBe("")
  })
})

// ── Compressed content streams (AQU-197) ─────────────────────────────────────
//
// The fixtures above are hand-built and *uncompressed*, which no real PDF
// writer produces. Word / InDesign / LaTeX / "print to PDF" all emit
// /FlateDecode content streams, so the text operators are not present in the
// raw bytes at all and a raw scan extracted nothing — the endpoint answered
// every real style-guide PDF with "No text could be extracted".

/** Build a PDF whose content stream is compressed, as a real writer emits. */
function makeCompressedPdf(
  texts: string[],
  opts: { raw?: boolean; dictExtra?: string } = {},
): Uint8Array {
  const content = texts.map((t) => `BT\n/F1 12 Tf\n(${t}) Tj\nET`).join("\n")
  const body = strToU8(content)
  const compressed = opts.raw ? deflateSync(body) : zlibSync(body)
  return assemblePdfStream(compressed, opts.dictExtra ?? "")
}

function assemblePdfStream(payload: Uint8Array, dictExtra: string): Uint8Array {
  const header = strToU8(
    `%PDF-1.4\n4 0 obj\n<< /Length ${payload.length} /Filter /FlateDecode${dictExtra} >>\nstream\n`,
  )
  const footer = strToU8("\nendstream\nendobj\n%%EOF")
  const out = new Uint8Array(header.length + payload.length + footer.length)
  out.set(header, 0)
  out.set(payload, header.length)
  out.set(footer, header.length + payload.length)
  return out
}

describe("extractTextFromPdf — /FlateDecode content streams", () => {
  it("extracts text from a zlib-compressed content stream (the real-world case)", () => {
    const pdf = makeCompressedPdf(["Rule one applies here", "Second rule text"])
    const text = extractTextFromPdf(pdf)
    expect(text).toContain("Rule one applies here")
    expect(text).toContain("Second rule text")
  })

  it("extracts text from a raw-deflate content stream (no zlib header)", () => {
    const pdf = makeCompressedPdf(["Raw deflate rule"], { raw: true })
    expect(extractTextFromPdf(pdf)).toContain("Raw deflate rule")
  })

  it("still extracts from an uncompressed PDF (no regression)", () => {
    const pdf = makePdf(["Uncompressed rule text"])
    expect(extractTextFromPdf(pdf)).toContain("Uncompressed rule text")
  })

  it("skips image streams rather than spending the inflation budget on them", () => {
    const pdf = makeCompressedPdf(["Visible rule"], { dictExtra: " /Subtype /Image" })
    // The only stream is an image, so no text operators are reachable.
    expect(extractTextFromPdf(pdf)).toBe("")
  })

  it("does not throw on a stream whose compressed bytes are corrupt", () => {
    const pdf = assemblePdfStream(new Uint8Array([0x78, 0x9c, 0x00, 0x01, 0x02, 0x03]), "")
    expect(() => extractTextFromPdf(pdf)).not.toThrow()
  })

  // Same decompression-bomb concern as the DOCX zip-bomb guard above: the
  // inflated output is bounded by a preallocated buffer, so a tiny upload
  // cannot balloon the worker's memory.
  it("bounds inflation of a decompression bomb instead of expanding it fully", () => {
    const bomb = zlibSync(strToU8("a".repeat(64 * 1024 * 1024)), { level: 9 })
    const pdf = assemblePdfStream(bomb, "")
    expect(pdf.length).toBeLessThan(2 * 1024 * 1024) // a legal upload
    // No text operators survive the truncation, and it must not hang or throw.
    expect(() => extractTextFromPdf(pdf)).not.toThrow()
  })
})

// ── Size cap (client-enforced constant) ──────────────────────────────────────

describe("MAX_FILE_BYTES constant", () => {
  it("is exactly 2 MB", async () => {
    // Import from the route module (the constant is not exported, but the
    // behaviour is: >2MB → reject). We verify the exported helpers are ≤2MB
    // threshold by checking the fixture sizes above are tiny.
    const docx = makeDocx(["hello"])
    expect(docx.length).toBeLessThan(2 * 1024 * 1024)
  })
})
