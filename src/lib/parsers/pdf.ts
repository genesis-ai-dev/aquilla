// AQU-2551: read a PDF as an import source.
//
// pdf.js (`pdfjs-dist`) is loaded only when a PDF is read (dynamic import), and
// it parses in its own Web Worker in the browser: the worker file is emitted
// by Vite as a hashed asset and handed to pdf.js as its `workerSrc`. Where
// there is no Worker (tests, Node), pdf.js runs the same code inline.
//
// This module reads each page's positioned text, marked-content brackets and
// structure tree; `pdf-blocks.ts` turns them into paragraphs (tagged PDFs by
// their tags, untagged ones by their layout), and the paragraphs become cells
// with the Word import's own splitter, so a PDF and the .docx it was saved
// from come out cut the same way.
//
// A scanned PDF (pages that paint an image and hold no text), an empty one
// and a password-protected one are refused with a reason (`PdfReadError`);
// a PDF with some image-only pages imports its text pages and names the
// others. None of these go to the AI sandbox, which cannot do better.

import { v4 as uuid } from "uuid"
import type { CellUnit, TranslatableString } from "./core-types"
import { createUsfmFootnoteMarker } from "../footnotes/insert"
import { splitFootnoteAware } from "./docx"
import { pdfPagesToParagraphs, type PdfPageContent, type PdfPageItem, type PdfStructNode } from "./pdf-blocks"

/** `reader`: pdf.js itself could not start (its worker or code failed to
 *  load), which says nothing about the PDF. `reader-timeout`: pdf.js was
 *  still downloading when READER_LOAD_TIMEOUT_MS ran out (a slow network);
 *  that says nothing about the PDF either. */
export type PdfReadErrorCode = "password" | "scanned" | "empty" | "unreadable" | "reader" | "reader-timeout" | "too-complex"

/** A PDF the import refuses, with the reason. The caller words the message. */
export class PdfReadError extends Error {
  readonly code: PdfReadErrorCode

  constructor(code: PdfReadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "PdfReadError"
    this.code = code
  }
}

export interface PdfImport {
  strings: TranslatableString[]
  /** 1-based numbers of pages that hold only an image (scanned), when the
   *  PDF also has text pages. */
  imageOnlyPages: number[]
  tagged: boolean
}

export interface PdfParseOptions {
  cellUnit?: CellUnit
  /** Test hook: the read's time budget (READ_BUDGET_MS). */
  budgetMs?: number
  /** Test hook: how long loading the reader may take (READER_LOAD_TIMEOUT_MS). */
  loadTimeoutMs?: number
}

/** AQU-2551 review finding 4: a crafted PDF held a tab for 74 s at 1.65 GB.
 *  One rule bounds every read: past this time it stops, pdf.js's loading
 *  task is destroyed (which ends its worker) and the PDF is refused as too
 *  complex. A real 58-page Word PDF reads in about 2 s. */
export const READ_BUDGET_MS = 20_000

/** AQU-2551 (browser pass, finding 6c): the budget measures only the reading.
 *  It starts once pdf.js's code and its worker have loaded; on a slow network
 *  their download (about 0.5 MB compressed) counted against the PDF, and a
 *  6 KB PDF was refused as too complex. Loading has this separate, generous
 *  limit (about 40 kbit/s for the whole reader), and running out of it says
 *  the reader did not load. The download is not given up: trying again keeps
 *  waiting on it. */
export const READER_LOAD_TIMEOUT_MS = 120_000

// AQU-2551 review finding 12: the legacy build, for the main module and the
// worker. The modern build calls Map.prototype.getOrInsertComputed and
// Math.sumPrecise with no fallback, which older browsers lack; the legacy
// build carries the fallbacks.
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs")

let pdfjsPromise: Promise<PdfJs> | null = null

/** How pdf.js says its worker could not start: the reader failed, not the
 *  PDF (AQU-2551). */
const WORKER_FAILED = /Setting up fake worker failed/i

/** Waits for `work` until `deadline` (a `performance.now()` time), then
 *  gives up waiting with `reader-timeout`; the work itself goes on. */
function beforeLoadDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PdfReadError("reader-timeout", "PDF reader took too long to load")),
      Math.max(0, deadline - performance.now()),
    )
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

async function loadPdfJs(deadline: number): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    if (typeof window !== "undefined" && typeof Worker !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
      const { default: workerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    }
    return pdfjs
  })()
  const loading = pdfjsPromise
  try {
    return await beforeLoadDeadline(loading, deadline)
  } catch (err) {
    // still downloading: a retry waits on this same download
    if (err instanceof PdfReadError) throw err
    if (pdfjsPromise === loading) pdfjsPromise = null
    throw new PdfReadError("reader", `PDF reader could not load: ${(err as Error)?.message ?? String(err)}`, { cause: err })
  }
}

/** A worker made by the reader, ready once pdf.js's worker script has
 *  downloaded and run (it then posts "ready"). */
interface StartingWorker {
  port: Worker
  ready: Promise<void>
  failed: boolean
}

/** A worker still downloading when a read gave up waiting for it: the next
 *  read takes it, so trying again does not start the download over. */
let spareWorker: StartingWorker | null = null

/** Starts pdf.js's worker; undefined when the constructor throws (no module
 *  workers, a cross-origin URL). */
function startWorker(src: string): StartingWorker | undefined {
  let port: Worker
  try {
    port = new Worker(src, { type: "module" })
  } catch {
    return undefined
  }
  const starting: StartingWorker = { port, ready: Promise.resolve(), failed: false }
  starting.ready = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { sourceName?: string; action?: string } | null
      if (data?.sourceName !== "worker" || data.action !== "ready") return
      done()
      resolve()
    }
    // AQU-2551 re-review finding 1: a worker that fails to start, or whose
    // script fails to load, fires `error`. That is the reader failing, never
    // the PDF: refuse at once.
    const onError = () => {
      done()
      starting.failed = true
      reject(new PdfReadError("reader", "PDF reader worker failed to start"))
    }
    const done = () => {
      port.removeEventListener("message", onMessage as EventListener)
      port.removeEventListener("error", onError)
    }
    port.addEventListener("message", onMessage as EventListener)
    port.addEventListener("error", onError)
  })
  starting.ready.catch(() => {})
  return starting
}

/** Loads the reader: pdf.js's code, then a worker that has said it is ready
 *  (or, with no Web Worker, pdf.js's in-page fallback). Within the load
 *  timeout; none of this counts against the read's budget. */
async function openReader(loadTimeoutMs: number): Promise<{ pdfjs: PdfJs; port?: Worker; pdfWorker?: InstanceType<PdfJs["PDFWorker"]> }> {
  const deadline = performance.now() + loadTimeoutMs
  const pdfjs = await loadPdfJs(deadline)
  if (typeof window !== "undefined" && typeof Worker !== "undefined" && pdfjs.GlobalWorkerOptions.workerSrc) {
    const spare = spareWorker && !spareWorker.failed ? spareWorker : null
    spareWorker = null
    const starting = spare ?? startWorker(pdfjs.GlobalWorkerOptions.workerSrc)
    if (starting) {
      try {
        await beforeLoadDeadline(starting.ready, deadline)
      } catch (err) {
        if (err instanceof PdfReadError && err.code === "reader-timeout" && !starting.failed) spareWorker = starting
        else starting.port.terminate()
        throw err
      }
      // AQU-2551: pdf.js's constructor types say `port?: null` (its JSDoc),
      // while its PDFWorkerParameters, and the code, take a Worker.
      return { pdfjs, port: starting.port, pdfWorker: new pdfjs.PDFWorker({ port: starting.port as unknown as null }) }
    }
  }
  // AQU-2551 re-review finding 1: no worker of our own. pdf.js makes its own,
  // or falls back to reading in the page (downloading its worker code as a
  // module); either way that loading is waited for here, not in the budget.
  const pdfWorker = new pdfjs.PDFWorker()
  try {
    await beforeLoadDeadline(Promise.resolve(pdfWorker.promise), deadline)
  } catch (err) {
    pdfWorker.destroy()
    if (err instanceof PdfReadError) throw err
    throw new PdfReadError("reader", `PDF reader failed: ${(err as Error)?.message ?? String(err)}`, { cause: err })
  }
  return { pdfjs, pdfWorker }
}

/** The pdf.js drawing operations that paint an image. */
function imagePaintOps(pdfjs: PdfJs): Set<number> {
  const ops = pdfjs.OPS as Record<string, number | undefined>
  return new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintInlineImageXObjectGroup,
    ops.paintImageMaskXObject,
    ops.paintImageMaskXObjectGroup,
    ops.paintImageXObjectRepeat,
    ops.paintImageMaskXObjectRepeat,
    ops.paintSolidColorImageMask,
  ].filter((op): op is number => typeof op === "number"))
}

interface RawTextItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  hasEOL?: boolean
  dir?: string
  type?: string
  id?: string
  tag?: string
}

function toPageItems(items: readonly RawTextItem[]): PdfPageItem[] {
  const out: PdfPageItem[] = []
  for (const it of items) {
    if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
      out.push({ mc: "begin", id: it.id ?? null, tag: it.tag ?? null })
    } else if (it.type === "endMarkedContent") {
      out.push({ mc: "end" })
    } else if (typeof it.str === "string" && it.transform) {
      out.push({
        s: it.str,
        x: it.transform[4],
        y: it.transform[5],
        b: it.transform[1],
        w: it.width ?? 0,
        h: it.height ?? 0,
        eol: !!it.hasEOL,
        dir: it.dir ?? "ltr",
      })
    }
  }
  return out
}

const hasText = (items: readonly PdfPageItem[]) => items.some((it) => "s" in it && it.s.trim() !== "")

/** Read a PDF into import cells. Throws `PdfReadError` for a PDF it refuses. */
export async function extractPdfImport(buffer: ArrayBuffer, options?: PdfParseOptions): Promise<PdfImport> {
  const read = await readPdfParagraphs(buffer, (text) => createUsfmFootnoteMarker({ caller: "+", text }), options)
  return { strings: paragraphsToStrings(read.paragraphs, options?.cellUnit), imageOnlyPages: read.imageOnlyPages, tagged: read.tagged }
}

/** AQU-2551: a PDF's plain text, one paragraph per line, for the rule import
 *  and the Knowledge Base. They read the PDF here, in the browser, with the
 *  import's own reader, and send the server only this text (review findings
 *  1–3: the server no longer parses PDFs). A footnote stays at its mark, in
 *  brackets. Throws `PdfReadError` for a PDF it refuses, as the import does. */
export async function extractPdfText(buffer: ArrayBuffer, options?: Pick<PdfParseOptions, "budgetMs" | "loadTimeoutMs">): Promise<string> {
  const read = await readPdfParagraphs(buffer, (text) => ` [${text}]`, options)
  return read.paragraphs.map((p) => p.text).join("\n")
}

interface PdfParagraphsRead {
  paragraphs: ReturnType<typeof pdfPagesToParagraphs>["paragraphs"]
  imageOnlyPages: number[]
  tagged: boolean
}

async function readPdfParagraphs(
  buffer: ArrayBuffer,
  footnote: (text: string) => string,
  { budgetMs = READ_BUDGET_MS, loadTimeoutMs = READER_LOAD_TIMEOUT_MS }: Pick<PdfParseOptions, "budgetMs" | "loadTimeoutMs"> = {},
): Promise<PdfParagraphsRead> {
  const { pdfjs, port, pdfWorker } = await openReader(loadTimeoutMs)
  // The budget, from here: the reader has loaded. In the browser pdf.js works in its own Web Worker, so a
  // timer fires while one page is still being read: every wait on pdf.js
  // races it. Where pdf.js runs on this thread (tests), timers wait for it,
  // so the clock is also read after every wait.
  const tooComplex = () => new PdfReadError("too-complex", `PDF took over ${budgetMs} ms to read`)
  const deadline = performance.now() + budgetMs
  // AQU-2551 (browser run): pdf.js's own destroy() waits for its worker, and a
  // worker busy decoding one huge stream answers only when it is done (54 s
  // for a 1 GB stream). So in the browser the reader owns the worker, and the
  // budget ends it outright: terminate(), then refuse at once. Without a
  // worker of our own (openReader) the budget still holds, though it can
  // then only destroy the loading task.
  /** Set when the read is given up (the budget ran out, or the worker
   *  failed): pdf.js is then not waited for. */
  let abandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<never>((_, reject) => {
    const abandon = (err: PdfReadError) => {
      if (abandoned) return
      abandoned = true
      port?.terminate()
      reject(err)
    }
    timer = setTimeout(() => abandon(tooComplex()), budgetMs)
    // a worker that dies while reading is the reader failing, never the PDF
    port?.addEventListener("error", () => abandon(new PdfReadError("reader", "PDF reader worker failed")))
  })
  /** Ends pdf.js: politely when it is idle, at once when the read was given up. */
  const finish = async (): Promise<void> => {
    clearTimeout(timer)
    if (abandoned) {
      void task.destroy().catch(() => {})
      pdfWorker?.destroy()
    } else {
      await task.destroy().catch(() => {})
      pdfWorker?.destroy()
    }
    port?.terminate()
  }
  stopped.catch(() => {})
  const within = async <T,>(work: Promise<T>): Promise<T> => {
    const value = await Promise.race([work, stopped])
    if (performance.now() > deadline) throw tooComplex()
    return value
  }
  // pdf.js transfers (detaches) the bytes it is given: hand it a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer.slice(0)),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    ...(pdfWorker ? { worker: pdfWorker } : {}),
  })
  let doc: Awaited<typeof task.promise>
  try {
    doc = await within(task.promise)
  } catch (err) {
    await finish()
    if (err instanceof PdfReadError) throw err
    const name = (err as { name?: string } | null)?.name
    if (name === "PasswordException") throw new PdfReadError("password", "PDF is password-protected", { cause: err })
    const message = (err as Error)?.message ?? String(err)
    // AQU-2551 review finding 11: only the reader failing to start says so;
    // every other error on opening is about the file.
    if (WORKER_FAILED.test(message)) throw new PdfReadError("reader", `PDF reader failed: ${message}`, { cause: err })
    throw new PdfReadError("unreadable", `PDF could not be read: ${message}`, { cause: err })
  }
  try {
    return await readOpenedPdf()
  } catch (err) {
    // AQU-2551 review finding 11: any error once the PDF is open ("Pages tree
    // contains circular reference.") is about the file, never pdf.js's words.
    if (err instanceof PdfReadError) throw err
    throw new PdfReadError("unreadable", `PDF could not be read: ${(err as Error)?.message ?? String(err)}`, { cause: err })
  } finally {
    await finish()
  }

  async function readOpenedPdf(): Promise<PdfParagraphsRead> {
    const paintOps = imagePaintOps(pdfjs)
    const pages: PdfPageContent[] = []
    const imageOnlyPages: number[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await within(doc.getPage(n))
      try {
        const content = await within(page.getTextContent({ includeMarkedContent: true }))
        const items = toPageItems(content.items as RawTextItem[])
        if (!hasText(items)) {
          // no text: a scanned page paints an image, an empty one nothing
          const ops = await within(page.getOperatorList())
          if (ops.fnArray.some((fn) => paintOps.has(fn))) imageOnlyPages.push(n)
          continue
        }
        const tree = (await within(page.getStructTree().catch(() => null))) as PdfStructNode | null
        const [x0, y0, x1, y1] = page.view
        pages.push({ n, box: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }, items, tree })
      } finally {
        page.cleanup()
      }
    }
    if (pages.length === 0) {
      if (imageOnlyPages.length > 0) throw new PdfReadError("scanned", "PDF is a scanned image with no text")
      throw new PdfReadError("empty", "PDF has no text")
    }
    const read = pdfPagesToParagraphs(pages, footnote)
    if (read.paragraphs.length === 0) throw new PdfReadError(imageOnlyPages.length ? "scanned" : "empty", "PDF has no text")
    return { paragraphs: read.paragraphs, imageOnlyPages, tagged: read.tagged }
  }
}

/** Paragraphs → cells, with the Word import's splitter: one cell per
 *  paragraph on the Paragraph setting, sentences on the Sentence setting. */
function paragraphsToStrings(paragraphs: ReturnType<typeof pdfPagesToParagraphs>["paragraphs"], cellUnit: CellUnit = "sentence"): TranslatableString[] {
  const results: TranslatableString[] = []
  const perPage = new Map<number, number>()
  for (const p of paragraphs) {
    const k = (perPage.get(p.page) ?? 0) + 1
    perPage.set(p.page, k)
    const sourceLocation = { file: `page/${p.page}`, blockPath: `block[${k}]` }
    const segments = splitFootnoteAware(p.text, cellUnit)
    segments.forEach((seg, i) => {
      results.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context: p.heading ?? "Paragraph",
        group: seg.group,
        type: p.heading ? "heading" : "text",
        sourceLocation,
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    })
  }
  return results
}
