/**
 * AQU-2551 (browser pass, finding 6c): pdf.js's own code is downloaded when
 * the first PDF is read. A download that outlasts the load timeout says the
 * reader did not load (never that the PDF is too complex), and a retry keeps
 * waiting on that same download. Here pdf.js is a stand-in that takes 400 ms
 * to arrive, and there is no Worker (pdf.js reads in the page).
 */

import { describe, expect, it, vi } from "vitest"

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async () => {
  await new Promise((resolve) => setTimeout(resolve, 400))
  const page = {
    view: [0, 0, 600, 800],
    cleanup() {},
    getStructTree: async () => null,
    getTextContent: async () => ({ items: [{ str: "Hello world.", transform: [12, 0, 0, 12, 72, 700], width: 60, height: 12, dir: "ltr" }] }),
    getOperatorList: async () => ({ fnArray: [] }),
  }
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    OPS: {},
    VerbosityLevel: { ERRORS: 0 },
    PDFWorker: class { promise = Promise.resolve(); destroy() {} },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => {} }),
  }
})

import { extractPdfImport, PdfReadError } from "./pdf"

describe("a PDF reader whose code is slow to download", () => {
  it("says the reader did not load in time, then reads the PDF on a retry once it has arrived", async () => {
    const err = await extractPdfImport(new TextEncoder().encode("%PDF-1.7").buffer, { loadTimeoutMs: 100 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("reader-timeout")
    const read = await extractPdfImport(new TextEncoder().encode("%PDF-1.7").buffer, { budgetMs: 100 })
    expect(read.strings.map((s) => s.original)).toEqual(["Hello world."])
  })
})
