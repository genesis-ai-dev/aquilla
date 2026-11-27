/**
 * AQU-2551 review finding 4, the browser's half: there pdf.js works in its
 * own Web Worker, so a page can take any time while the tab waits. A read
 * past its budget must end that work: the loading task is destroyed (which
 * terminates the worker) and the PDF is refused as too complex. Here pdf.js
 * is a stand-in whose worker never answers.
 */

import { describe, expect, it, vi } from "vitest"

const destroy = vi.fn(async () => {})

// AQU-2551 review finding 12: the reader loads the legacy build.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  OPS: {},
  VerbosityLevel: { ERRORS: 0 },
  // with no worker of the reader's own, pdf.js's in-page reader, ready at once
  PDFWorker: class { promise = Promise.resolve(); destroy() {} },
  getDocument: () => ({
    // a document whose first page never comes back
    promise: Promise.resolve({ numPages: 1, getPage: () => new Promise(() => {}) }),
    destroy,
  }),
}))

import { extractPdfImport, PdfReadError } from "./pdf"

describe("a PDF whose reading never ends", () => {
  it("is stopped at the budget, and pdf.js's work is ended", async () => {
    const err = await extractPdfImport(new TextEncoder().encode("%PDF-1.7").buffer, { budgetMs: 50 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("too-complex")
    expect(destroy).toHaveBeenCalled()
  })
})
