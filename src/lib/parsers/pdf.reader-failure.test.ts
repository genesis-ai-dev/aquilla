/**
 * AQU-2551 review finding: when pdf.js itself cannot start (its worker file
 * gone after a deploy, a blocked script), the person was told their PDF was
 * damaged. The reader now says the reader failed, and the PDF is fine.
 */

import { describe, expect, it, vi } from "vitest"

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  OPS: {},
  VerbosityLevel: { ERRORS: 0 },
  getDocument: () => ({
    promise: Promise.reject(new Error("Setting up fake worker failed: Failed to fetch dynamically imported module")),
    destroy: async () => {},
  }),
}))

import { extractPdfImport, PdfReadError } from "./pdf"
import { readPdfImport } from "@/lib/import/pdf-import"

describe("a PDF reader that cannot start", () => {
  it("is reported as the reader failing, not as a damaged PDF", async () => {
    const err = await extractPdfImport(new TextEncoder().encode("%PDF-1.7").buffer).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("reader")
    await expect(readPdfImport(new TextEncoder().encode("%PDF-1.7").buffer)).rejects.toThrow(
      "Aquilla could not start its PDF reader. Reload the page and import the PDF again.",
    )
  })
})
