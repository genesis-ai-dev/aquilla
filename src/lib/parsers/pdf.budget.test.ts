/**
 * AQU-2551 review finding 4: a crafted PDF tied up the tab for 74 s at
 * 1.65 GB, with no budget. The reader now stops after a fixed time, ends
 * pdf.js's work (its worker, in the browser) and says the PDF is too complex.
 * The reviewer's crafted files, made small: many pages that all draw one
 * content stream full of tiny positioned text pieces.
 */

import { describe, expect, it } from "vitest"
import { extractPdfImport, PdfReadError } from "./pdf"
import { readPdfImport } from "@/lib/import/pdf-import"

/** One content stream, drawn by every page: `pieces` one-letter text pieces. */
function manyPiecesPdf(pages: number, pieces: number): ArrayBuffer {
  const stream = "BT /F1 1 Tf 72 400 Td " + "1 0 Td (a) Tj ".repeat(pieces) + " ET"
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(" ")
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>"),
  ]
  let out = "%PDF-1.7\n"
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out).buffer as ArrayBuffer
}

describe("a PDF too complex to read in time", () => {
  it("is stopped at the budget and refused, and the tab is not held", async () => {
    const pdf = manyPiecesPdf(400, 20_000)
    expect(pdf.byteLength).toBeLessThan(400_000) // a small file
    const t0 = performance.now()
    const err = await extractPdfImport(pdf, { budgetMs: 150 }).catch((e: unknown) => e)
    const took = performance.now() - t0
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("too-complex")
    expect(took).toBeLessThan(2_000)
  })

  it("tells the person to save it again or import the original", async () => {
    await expect(readPdfImport(manyPiecesPdf(400, 20_000), { budgetMs: 150 })).rejects.toThrow(
      "This PDF is too complex to read. Save it again from the program that made it, or import the original document.",
    )
  })

  it("reads an ordinary PDF well inside the default budget", async () => {
    const read = await extractPdfImport(manyPiecesPdf(1, 50), {})
    expect(read.strings.length).toBeGreaterThan(0)
  })
})
