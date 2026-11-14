/**
 * AQU-2551 re-review finding 1: the reader makes pdf.js's worker itself (so
 * the budget can end it), and nothing listened for the worker failing. A
 * worker whose script never loads (its hashed file gone after a deploy, a
 * blocked script) left the person waiting the whole 20 s, then told them the
 * PDF was too complex. A worker constructor that throws (no module workers, a
 * cross-origin URL) threw outside the reader's guard, in raw English.
 *
 * Here pdf.js is a stand-in, and the browser's Worker is replaced per test.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

const S = vi.hoisted(() => ({
  params: [] as Array<Record<string, unknown>>,
  /** "ok": the page reads; "hang": the page never comes back. */
  mode: "ok" as "ok" | "hang",
}))

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
    S.params.push(params)
    const page = {
      view: [0, 0, 600, 800],
      cleanup() {},
      getStructTree: async () => null,
      getTextContent: () => S.mode === "hang"
        ? new Promise(() => {})
        : Promise.resolve({ items: [{ str: "Hello world.", transform: [12, 0, 0, 12, 72, 700], width: 60, height: 12, dir: "ltr" }] }),
      getOperatorList: async () => ({ fnArray: [] }),
    }
    // the stand-in never answers through a dead worker: it waits, as pdf.js does
    const worker = params.worker as { port?: { dead?: boolean } } | undefined
    const dead = worker?.port?.dead === true
    return {
      promise: dead ? new Promise(() => {}) : Promise.resolve({ numPages: 1, getPage: async () => page }),
      destroy: () => dead ? new Promise(() => {}) : Promise.resolve(),
    }
  },
}))

import { extractPdfImport, PdfReadError } from "./pdf"
import { readPdfImport } from "@/lib/import/pdf-import"

const pdf = () => new TextEncoder().encode("%PDF-1.7").buffer as ArrayBuffer

/** A worker whose script fails to load: the browser fires `error` on it. */
class DeadWorker extends EventTarget {
  dead = true
  terminated = false
  constructor() {
    super()
    setTimeout(() => this.dispatchEvent(new Event("error")), 5)
  }
  postMessage() {}
  terminate() { this.terminated = true }
}

/** A browser without module workers: the constructor throws. */
class NoModuleWorker {
  constructor() { throw new TypeError("Module scripts are not supported on DedicatedWorker yet.") }
}

afterEach(() => {
  vi.unstubAllGlobals()
  S.params.length = 0
  S.mode = "ok"
})

describe("a PDF reader whose worker fails to start", () => {
  it("is refused at once as a reader failure, not after the budget as too complex", async () => {
    vi.stubGlobal("Worker", DeadWorker)
    const t0 = performance.now()
    const err = await extractPdfImport(pdf(), { budgetMs: 5_000 }).catch((e: unknown) => e)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("reader")
    await expect(readPdfImport(pdf(), { budgetMs: 5_000 })).rejects.toThrow(
      "Aquilla could not start its PDF reader. Reload the page and import the PDF again.",
    )
  })
})

describe("a browser whose Worker constructor throws", () => {
  it("lets pdf.js make its own worker (or its main-thread fallback), and the PDF reads", async () => {
    vi.stubGlobal("Worker", NoModuleWorker)
    const read = await extractPdfImport(pdf())
    expect(read.strings.map((s) => s.original)).toEqual(["Hello world."])
    expect(S.params[0]?.worker).toBeUndefined()
  })

  it("still keeps the read's budget", async () => {
    vi.stubGlobal("Worker", NoModuleWorker)
    S.mode = "hang"
    const err = await extractPdfImport(pdf(), { budgetMs: 50 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfReadError)
    expect((err as PdfReadError).code).toBe("too-complex")
  })
})
