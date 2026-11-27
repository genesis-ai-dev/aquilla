/**
 * AQU-2551 (browser pass, finding 6c): on a slow network a 6 KB PDF was
 * refused as "too complex". The read's budget started before pdf.js's worker
 * script had downloaded, so the download counted against the PDF. The budget
 * now measures only the reading: it starts once the worker has said it is
 * ready. Loading the reader has its own, generous timeout, and running out of
 * it says the reader did not load, never that the PDF is too complex. A retry
 * keeps waiting on the same download rather than starting it again.
 *
 * Here pdf.js is a stand-in, and the browser's Worker is replaced per test.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

const S = vi.hoisted(() => ({ made: 0 }))

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "/assets/pdf.worker.legacy.mjs" },
  OPS: {},
  VerbosityLevel: { ERRORS: 0 },
  PDFWorker: class {
    port: unknown
    constructor({ port }: { port: unknown }) { this.port = port }
    destroy() {}
  },
  getDocument: (params: Record<string, unknown>) => {
    const page = {
      view: [0, 0, 600, 800],
      cleanup() {},
      getStructTree: async () => null,
      getTextContent: async () => ({ items: [{ str: "Hello world.", transform: [12, 0, 0, 12, 72, 700], width: 60, height: 12, dir: "ltr" }] }),
      getOperatorList: async () => ({ fnArray: [] }),
    }
    // as in a browser: messages to a worker wait until its script has run
    const port = (params.worker as { port?: SlowWorker } | undefined)?.port
    return {
      promise: (port?.loaded ?? Promise.resolve()).then(() => ({ numPages: 1, getPage: async () => page })),
      destroy: async () => {},
    }
  },
}))

import { extractPdfImport, PdfReadError } from "./pdf"
import { readPdfImport } from "@/lib/import/pdf-import"

const pdf = () => new TextEncoder().encode("%PDF-1.7").buffer as ArrayBuffer

/** How long the next worker's script takes to download (Infinity: never). */
let downloadMs = 0

/** A worker whose script takes `downloadMs` to arrive, then says "ready" as
 *  pdf.js's worker does. */
class SlowWorker extends EventTarget {
  loaded: Promise<void>
  terminated = false
  constructor() {
    super()
    S.made++
    const ms = downloadMs
    this.loaded = new Promise((resolve) => {
      if (!Number.isFinite(ms)) return
      setTimeout(() => {
        if (this.terminated) return
        this.dispatchEvent(new MessageEvent("message", { data: { sourceName: "worker", targetName: "main", action: "ready", data: new Uint8Array() } }))
        resolve()
      }, ms)
    })
  }
  postMessage() {}
  terminate() { this.terminated = true }
}

afterEach(() => {
  vi.unstubAllGlobals()
  S.made = 0
  downloadMs = 0
})

describe("a small PDF on a slow network", () => {
  it("is read: the reader's download does not count against the read's budget", async () => {
    vi.stubGlobal("Worker", SlowWorker)
    downloadMs = 300
    const read = await extractPdfImport(pdf(), { budgetMs: 100 })
    expect(read.strings.map((s) => s.original)).toEqual(["Hello world."])
  })
})

describe("a reader that does not finish loading in time", () => {
  it("on a retry, keeps waiting on the same download instead of starting again", async () => {
    vi.stubGlobal("Worker", SlowWorker)
    downloadMs = 300
    const first = await extractPdfImport(pdf(), { loadTimeoutMs: 100 }).catch((e: unknown) => e)
    expect((first as PdfReadError).code).toBe("reader-timeout")
    const made = S.made
    const read = await extractPdfImport(pdf(), { budgetMs: 100 })
    expect(read.strings.map((s) => s.original)).toEqual(["Hello world."])
    expect(S.made).toBe(made)
  })

  // last: it leaves a worker that never loads waiting for a retry
  it("says the reader did not load, never that the PDF is too complex", async () => {
    vi.stubGlobal("Worker", SlowWorker)
    downloadMs = Infinity
    const err = await extractPdfImport(pdf(), { budgetMs: 2_000, loadTimeoutMs: 100 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("reader-timeout")
    await expect(readPdfImport(pdf(), { budgetMs: 2_000, loadTimeoutMs: 100 })).rejects.toThrow(
      "Aquilla's PDF reader took too long to load. Check your connection, then import the PDF again.",
    )
  })
})
