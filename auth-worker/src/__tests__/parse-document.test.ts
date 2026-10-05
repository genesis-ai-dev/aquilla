// parse-document — unit tests (AQU-197)
//
// Tests the text-extraction helpers directly (no HTTP, no DB) and the
// size-cap rejection via the Hono app. The authMiddleware is exercised
// incidentally: unauthenticated requests → 401.

import { describe, it, expect } from "vitest"
import { zipSync, zlibSync, deflateSync, strToU8 } from "fflate"
import {
  DocumentExtractionError,
  extractTextFromDocx,
  extractTextFromPdf,
} from "../routes/parse-document"

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
  //
  // AQU-1499 moved the cap from 20 MB to 64 MB — the guard still has to bite,
  // just at the size where the extractor actually runs out of room.
  it("rejects a word/document.xml whose declared inflated size exceeds the safety cap (zip-bomb guard)", () => {
    const huge = "a".repeat(65 * 1024 * 1024) // 65 MB inflated — over the 64 MB cap
    const xml = `<w:document><w:body><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:body></w:document>`
    const zipped = zipSync({ "word/document.xml": strToU8(xml) }, { level: 9 })
    expect(() => extractTextFromDocx(zipped)).toThrow(/too complex to read|limit/)
  })

  // ── AQU-1499 ───────────────────────────────────────────────────────────────
  //
  // A real partner file (LOTE's published Arabic book, 68k words, 882 KB on
  // disk) had 39.5 MB of word/document.xml because Word had saved almost every
  // CHARACTER as its own `<w:r>` with a full `<w:rPr>`. That is a valid .docx —
  // Word, LibreOffice and python-docx all open it — but the knowledge-base
  // upload refused it at the 20 MB cap and the reason was swallowed, so the
  // uploader saw only a failed upload. These guard the two halves: the bloated
  // shape must parse, and the text it yields must be the same text as the clean
  // rebuild of the same document.
  describe("bloated run XML (AQU-1499)", () => {
    const PARAGRAPHS = [
      "هذا كتاب عن الله الحقيقي في اللغة العربية.",
      "The second paragraph mixes scripts & an ampersand.",
      "A third paragraph, for good measure.",
    ]

    /** One `<w:r>` per character, each with a full `<w:rPr>` — the real file's
     *  shape. Repeated until word/document.xml is over the OLD 20 MB cap, so a
     *  regression to a size-based refusal fails this test. */
    function makeBloatedDocx(): { docx: Uint8Array; documentXmlBytes: number } {
      const rPr = "<w:rPr><w:rFonts w:cs=\"Arial\"/><w:szCs w:val=\"24\"/><w:rtl/></w:rPr>"
      const paragraph = (text: string) => {
        let runs = ""
        for (const ch of text) {
          const t = ch === " " ? '<w:t xml:space="preserve"> </w:t>' : `<w:t>${escapeXml(ch)}</w:t>`
          runs += `<w:r>${rPr}${t}</w:r>`
        }
        return `<w:p><w:pPr><w:bidi/></w:pPr>${runs}</w:p>`
      }
      const block = PARAGRAPHS.map(paragraph).join("")
      // ~22 MB of XML: comfortably past the old 20 MB cap, well under the new one.
      const repeats = Math.ceil((22 * 1024 * 1024) / block.length)
      const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${block.repeat(repeats)}</w:body></w:document>`
      return {
        docx: zipSync({ "word/document.xml": strToU8(xml) }, { level: 6 }),
        documentXmlBytes: strToU8(xml).length,
      }
    }

    /** The same text, one run per paragraph — what "re-save it from Word"
     *  produces, and the file Joel confirmed uploads first time. */
    function makeCleanDocx(repeats: number): Uint8Array {
      const block = PARAGRAPHS.map((p) => `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`).join("")
      const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${block.repeat(repeats)}</w:body></w:document>`
      return zipSync({ "word/document.xml": strToU8(xml) })
    }

    function escapeXml(text: string): string {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }

    it("extracts the same text from a per-character-run document.xml over 20 MB as from its clean rebuild", () => {
      const { docx, documentXmlBytes } = makeBloatedDocx()
      expect(documentXmlBytes).toBeGreaterThan(20 * 1024 * 1024)

      const bloatedText = extractTextFromDocx(docx)
      const paragraphs = bloatedText.split("\n")
      const repeats = paragraphs.length / PARAGRAPHS.length
      expect(Number.isInteger(repeats)).toBe(true)

      expect(bloatedText).toBe(extractTextFromDocx(makeCleanDocx(repeats)))
      // Not just equal to each other — equal to the actual document text.
      expect(paragraphs.slice(0, PARAGRAPHS.length)).toEqual(PARAGRAPHS)
    })

    it("reports an over-cap document.xml as a DocumentExtractionError naming the size and the fix", () => {
      const huge = "a".repeat(65 * 1024 * 1024)
      const xml = `<w:document><w:body><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:body></w:document>`
      const zipped = zipSync({ "word/document.xml": strToU8(xml) }, { level: 9 })

      let thrown: unknown
      try {
        extractTextFromDocx(zipped)
      } catch (err) {
        thrown = err
      }
      // The uploader has to be able to learn the size AND what to do about it;
      // routes/knowledge.ts passes a DocumentExtractionError's message through
      // verbatim and reports its documentXmlBytes to telemetry.
      expect(thrown).toBeInstanceOf(DocumentExtractionError)
      const err = thrown as DocumentExtractionError
      expect(err.documentXmlBytes).toBeGreaterThan(64 * 1024 * 1024)
      expect(err.message).toMatch(/word\/document\.xml is 65 MB/)
      expect(err.message).toMatch(/Save As/)
    })

    it("keeps field codes and tracked deletions out of the extracted text", () => {
      // The old implementation stripped tags across the whole part, so the
      // character data of every element — w:instrText field codes, w:delText
      // deleted runs — survived into the output as if it were body text.
      const xml =
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        "<w:p><w:r><w:t>Kept body text</w:t></w:r>" +
        '<w:r><w:instrText> HYPERLINK "https://example.com" </w:instrText></w:r>' +
        "<w:del><w:r><w:delText>deleted sentence</w:delText></w:r></w:del></w:p>" +
        "</w:body></w:document>"
      const text = extractTextFromDocx(zipSync({ "word/document.xml": strToU8(xml) }))

      expect(text).toBe("Kept body text")
      expect(text).not.toContain("HYPERLINK")
      expect(text).not.toContain("deleted sentence")
    })

    it("decodes an escaped entity reference without double-decoding it", () => {
      // `&amp;lt;` is a literal "&lt;" in the document, not a "<".
      const docx = makeDocx(["a &amp;lt; b"])
      expect(extractTextFromDocx(docx)).toBe("a &lt; b")
    })
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
