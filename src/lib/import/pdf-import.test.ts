/**
 * AQU-2551: what the person is told about a PDF the import cannot read
 * (question 56: refuse a scan with a clear message), and the notice for a PDF
 * whose text pages import while its scanned pages cannot.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildPdf } from "@/lib/parsers/__fixtures__/build-pdf"
import { readPdfImport } from "./pdf-import"

async function message(buffer: ArrayBuffer): Promise<string> {
  return readPdfImport(buffer).then(() => "read", (err: Error) => err.message)
}

const locked = () => {
  const b = readFileSync("src/lib/parsers/__fixtures__/pdf/locked.pdf")
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

describe("a PDF the import refuses says why", () => {
  it("a scanned PDF", async () => {
    expect(await message(buildPdf({ pages: [{ image: true }] }))).toBe("This PDF is a scanned image. It has no text to import.")
  })

  it("an empty PDF", async () => {
    expect(await message(buildPdf({ pages: [{}] }))).toBe("This PDF has no text.")
  })

  it("a password-protected PDF", async () => {
    expect(await message(locked())).toBe("This PDF is password-protected. Remove the password and import it again.")
  })

  it("a file that is not a PDF", async () => {
    expect(await message(new TextEncoder().encode("hello").buffer)).toBe("This file could not be read as a PDF.")
  })
})

describe("a PDF with some scanned pages", () => {
  it("imports its text and names the image-only pages", async () => {
    const read = await readPdfImport(buildPdf({ pages: [
      { runs: [{ text: "Text on page one.", x: 72, y: 700 }] },
      { image: true },
      { image: true },
    ] }), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => s.original)).toEqual(["Text on page one."])
    expect(read.importNotices).toEqual([{
      code: "pdf-image-only-pages",
      severity: "warning",
      message: "Pages 2, 3 are scanned images with no text, so they are not in this import.",
    }])
  })

  it("names a single page in the singular, and says nothing when no page is scanned", async () => {
    const one = await readPdfImport(buildPdf({ pages: [{ image: true }, { runs: [{ text: "Text.", x: 72, y: 700 }] }] }))
    expect(one.importNotices.map((n) => n.message)).toEqual(["Page 1 is a scanned image with no text, so it is not in this import."])
    const none = await readPdfImport(buildPdf({ pages: [{ runs: [{ text: "Text.", x: 72, y: 700 }] }] }))
    expect(none.importNotices).toEqual([])
  })
})
