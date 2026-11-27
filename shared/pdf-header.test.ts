import { describe, expect, it } from "vitest"
import { hasPdfHeader } from "./pdf-header"

// AQU-2551 re-review finding 9 (Nov 14): the app and the server took the PDF
// header only at the very start of a file, but pdf.js reads a PDF whose
// "%PDF-" comes later in the first kilobyte. A .pdf with a junk prefix read
// in the browser and was then refused by the server.
describe("the PDF header (AQU-2551)", () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  it("is found at the start, after a BOM or whitespace", () => {
    expect(hasPdfHeader(bytes("%PDF-1.7\n"))).toBe(true)
    expect(hasPdfHeader(new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, 0x20, ...bytes("%PDF-1.7\n")]))).toBe(true)
  })

  it("is found after a line break anywhere in the first kilobyte", () => {
    expect(hasPdfHeader(bytes("junk from a mail gateway\r\n%PDF-1.4\n"))).toBe(true)
    expect(hasPdfHeader(bytes(`${"x".repeat(1000)}\n%PDF-1.4\n`))).toBe(true)
  })

  it("is not found mid-line, or past the first kilobyte", () => {
    expect(hasPdfHeader(bytes("Every PDF starts with %PDF-1.7 in its first line.\n"))).toBe(false)
    expect(hasPdfHeader(bytes(`${"x".repeat(1100)}\n%PDF-1.4\n`))).toBe(false)
    expect(hasPdfHeader(bytes("%PDF"))).toBe(false)
  })
})
