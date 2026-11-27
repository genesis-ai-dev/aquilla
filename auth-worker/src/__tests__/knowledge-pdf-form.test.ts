/**
 * AQU-2551 re-review finding 6: a Knowledge Base PDF of up to about 31 MB
 * (the 25 MB original and its text) was held three times at once — the raw
 * body, the parsed form and the file's buffer — about 80–90 MB of a Worker's
 * 128 MB. The form is now parsed once, straight from the request, through a
 * byte cap, and only the file's one buffer is kept.
 *
 * The check counts copies, not memory: the old read and the new run side by
 * side while the test records every step — each chunk pulled from the
 * request, when the parser is handed its body (and whether that body is the
 * live stream or a buffer already holding the whole form), each whole-body
 * read (arrayBuffer/blob/bytes/text) and each file buffer taken. Node's heap
 * peak (heapUsed + arrayBuffers, as the reviewer's probe rereview/kb-mem.mjs
 * counts it) is still printed for the record, but it is not asserted: the
 * collector's timing under CI load decides it.
 */

import v8 from "node:v8"
import vm from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_KB_ORIGINAL_BYTES, MAX_KB_TEXT_CHARS } from "../../../db/shared/knowledge"
import { MAX_KB_PDF_FORM_BYTES, readPdfForm } from "../routes/knowledge"
import { startsAsPdf } from "../routes/parse-document"
import { readBytesWithLimit } from "../../../shared/http-body-limit"

const MB = 1024 * 1024

// a settled baseline for the printed peak: collect before it is taken
v8.setFlagsFromString("--expose-gc")
const gc = vm.runInNewContext("gc") as () => void

/** The read before the fix: the whole body into bytes, then parsed. */
async function oldReadPdfForm(headers: Headers, body: ReadableStream<Uint8Array> | null) {
  const upload = await readBytesWithLimit(headers, body, MAX_KB_PDF_FORM_BYTES)
  if (!upload.ok) return { ok: false as const }
  const form = await new Response(upload.bytes, { headers: { "content-type": headers.get("content-type") ?? "" } }).formData()
  const file = form.get("file") as File
  const text = form.get("text") as string
  return { ok: true as const, bytes: new Uint8Array(await file.arrayBuffer()), text: text.replace(/\r\n?/g, "\n") }
}

type Read = typeof oldReadPdfForm | typeof readPdfForm

/** The reviewer's case: a 25 MB original and ~4 MB of CRLF text. */
function bigForm() {
  const pdf = new Uint8Array(MAX_KB_ORIGINAL_BYTES - 1024)
  pdf.set(new TextEncoder().encode("%PDF-1.7\n"))
  const fd = new FormData()
  fd.append("file", new Blob([pdf]), "big.pdf")
  fd.append("text", "a\r\n".repeat((2_000_000 / 3) * 2))
  return new Request("http://x/", { method: "POST", body: fd })
}

/** The source stream the read pulls from, logging each pull and the end. */
function loggedBody(req: Request, log: string[], onPull?: () => void) {
  const reader = req.body!.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { done, value } = await reader.read()
      onPull?.()
      if (done) { log.push("source done"); ctrl.close() } else { log.push("pull"); ctrl.enqueue(value) }
    },
  })
}

const bodyKind = (body: unknown) =>
  body instanceof ReadableStream ? "stream"
  : body instanceof Uint8Array || body instanceof ArrayBuffer ? `buffer ${(body as ArrayBufferLike).byteLength}`
  : body === null || body === undefined ? "none" : "other"

/** Runs a read with every copy-making step recorded, in order. */
async function trace(read: Read) {
  const req = bigForm()
  const formBytes = (await req.clone().arrayBuffer()).byteLength
  const log: string[] = []
  const RealResponse = globalThis.Response
  class TracedResponse extends RealResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      log.push(`parser gets ${bodyKind(body)}`)
      super(body, init)
    }
  }
  vi.stubGlobal("Response", TracedResponse)
  for (const proto of [RealResponse.prototype, Request.prototype]) {
    for (const m of ["arrayBuffer", "blob", "bytes", "text"] as const) {
      const real = proto[m] as (...a: unknown[]) => unknown
      vi.spyOn(proto, m).mockImplementation(function (this: unknown, ...a: unknown[]) {
        log.push(`whole body ${m}`)
        return real.apply(this, a)
      } as never)
    }
  }
  const realFileBuffer = Blob.prototype.arrayBuffer
  vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
    log.push(`file buffer ${this.size}`)
    return realFileBuffer.call(this)
  })
  try {
    const result = await read(new Headers({ "content-type": req.headers.get("content-type")! }), loggedBody(req, log))
    if (!result.ok) throw new Error("read failed")
    return { log, formBytes, fileBytes: result.bytes.byteLength, textLength: result.text.length }
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
}

/** Node's heap peak above a collected baseline: printed, never asserted. */
async function peakMB(read: Read) {
  const req = bigForm()
  let peak = 0
  const tick = () => { const m = process.memoryUsage(); peak = Math.max(peak, m.arrayBuffers + m.heapUsed) }
  const body = loggedBody(req, [], tick)
  gc()
  const base = process.memoryUsage()
  await read(new Headers({ "content-type": req.headers.get("content-type")! }), body)
  tick()
  return (peak - base.arrayBuffers - base.heapUsed) / MB
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("reading a Knowledge Base PDF form (AQU-2551)", () => {
  it("refuses a form whose declared length is over the cap without reading a byte", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({ pull() { pulls++; throw new Error("read") } }, { highWaterMark: 0 })
    const headers = new Headers({ "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_KB_PDF_FORM_BYTES + 1) })
    expect(await readPdfForm(headers, body)).toEqual({ ok: false, reason: "too-large" })
    expect(pulls).toBe(0)
  })

  it("refuses a form with no declared length once it runs past the cap", async () => {
    const chunk = new Uint8Array(MB)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) { if (sent > MAX_KB_PDF_FORM_BYTES + MB) ctrl.close(); else { sent += chunk.length; ctrl.enqueue(chunk) } },
    })
    const headers = new Headers({ "content-type": "multipart/form-data; boundary=x" })
    expect(await readPdfForm(headers, body)).toEqual({ ok: false, reason: "too-large" })
    expect(sent).toBeLessThanOrEqual(MAX_KB_PDF_FORM_BYTES + 2 * MB)
  })

  // The line-end pass runs over at most the text the server keeps, plus one
  // character so the route can still tell the text was cut.
  async function readText(text: string): Promise<string> {
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode("%PDF-1.7\n")]), "a.pdf")
    fd.append("text", text)
    const req = new Request("http://x/", { method: "POST", body: fd })
    const read = await readPdfForm(new Headers({ "content-type": req.headers.get("content-type")! }), req.body)
    if (!read.ok) throw new Error(read.reason)
    return read.text
  }

  it("cuts a long text one character past the cap, with LF line ends", async () => {
    const text = await readText("ab\n".repeat(MAX_KB_TEXT_CHARS))
    expect(text.length).toBe(MAX_KB_TEXT_CHARS + 1)
    expect(text.startsWith("ab\nab\n")).toBe(true)
    expect(text).not.toContain("\r")
  })

  it("still passes the cap when the text is over it only after its CRLFs become LF", async () => {
    // sent as "a\r\n" (3 characters a line), kept as "a\n" (2): the sent text
    // is far past the cap, the stored one just past it
    const text = await readText("a\n".repeat(MAX_KB_TEXT_CHARS / 2 + 1))
    expect(text.length).toBe(MAX_KB_TEXT_CHARS + 1)
  })

  it("keeps a text whole that is under the cap once its CRLFs become LF", async () => {
    const lines = MAX_KB_TEXT_CHARS / 2 - 10
    const text = await readText("a\n".repeat(lines))
    expect(text.length).toBe(lines * 2)
  })

  it("reads the original and its text with one copy of the form fewer than before", async () => {
    // the old read (raw body, then the parse) kept here as the yardstick
    const old = await trace(oldReadPdfForm)
    const now = await trace(readPdfForm)
    const pulls = (log: string[]) => log.filter((e) => e === "pull").length
    // the same file and text come out, the text cut one past the cap before
    // its line ends are changed
    expect(now.fileBytes).toBe(old.fileBytes)
    expect(now.textLength).toBe(Math.min(old.textLength, MAX_KB_TEXT_CHARS + 1))
    expect(pulls(now.log)).toBe(pulls(old.log))
    expect(pulls(now.log)).toBeGreaterThan(1)

    // the yardstick: the whole form is read into one buffer before the parser
    // sees a byte, then the file's buffer is taken — the copy the fix removed
    const oldParse = old.log.indexOf(`parser gets buffer ${old.formBytes}`)
    expect(oldParse).toBeGreaterThan(old.log.indexOf("source done"))
    expect(old.log.filter((e) => e.startsWith("file buffer"))).toEqual([`file buffer ${old.fileBytes}`])

    // now: the parser is handed the live request stream before the first
    // chunk is pulled, so no buffer of the whole form is ever made; nothing
    // reads the whole body; and the file's one buffer is the only copy taken
    expect(now.log.filter((e) => !["pull", "source done"].includes(e))).toEqual([
      "parser gets stream",
      `file buffer ${now.fileBytes}`,
    ])
    expect(now.log[0]).toBe("parser gets stream")
    expect(now.log.indexOf(`file buffer ${now.fileBytes}`)).toBeGreaterThan(now.log.indexOf("source done"))

    // for the record only (GC timing decides it, so it is not a bar)
    const before = await peakMB(oldReadPdfForm)
    const after = await peakMB(readPdfForm)
    console.log(`AQU-2551 KB memory: form=${(now.formBytes / MB).toFixed(1)} MB; peak above baseline (heap+ArrayBuffers, Node, diagnostic): before ${before.toFixed(0)} MB, now ${after.toFixed(0)} MB; file=${(now.fileBytes / MB).toFixed(1)} MB`)
  }, 60_000)
})

// AQU-2551 re-review finding 9: the server takes the header where pdf.js
// does, so a PDF the browser read is not refused here as "not a PDF".
describe("a stored original's PDF header (AQU-2551)", () => {
  it("is taken after a line break in the first kilobyte", () => {
    expect(startsAsPdf(new TextEncoder().encode("junk\r\n%PDF-1.4\n"))).toBe(true)
    expect(startsAsPdf(new TextEncoder().encode("mentions %PDF-1.4 mid-line\n"))).toBe(false)
  })
})
