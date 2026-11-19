/**
 * AQU-2551 re-review finding 6: a Knowledge Base PDF of up to about 31 MB
 * (the 25 MB original and its text) was held three times at once — the raw
 * body, the parsed form and the file's buffer — about 80–90 MB of a Worker's
 * 128 MB. The form is now parsed once, straight from the request, through a
 * byte cap, and only the file's one buffer is kept.
 *
 * Memory is counted as the reviewer's probe (rereview/kb-mem.mjs) counts it:
 * Node's heapUsed + arrayBuffers, sampled at every chunk the reader pulls and
 * once the read returns, peak minus a collected baseline; the old read and
 * the new are counted side by side, and printed.
 */

import v8 from "node:v8"
import vm from "node:vm"
import { describe, expect, it } from "vitest"
import { MAX_KB_ORIGINAL_BYTES } from "../../../db/shared/knowledge"
import { MAX_KB_PDF_FORM_BYTES, readPdfForm } from "../routes/knowledge"
import { readBytesWithLimit } from "../../../shared/http-body-limit"

const MB = 1024 * 1024

// a settled baseline: collect before it is taken (Node's collector otherwise
// runs when it likes, and one run's peak swings by tens of MB)
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

async function measure(read: typeof oldReadPdfForm | typeof readPdfForm) {
  const pdf = new Uint8Array(MAX_KB_ORIGINAL_BYTES - 1024)
  pdf.set(new TextEncoder().encode("%PDF-1.7\n"))
  const text = "a\r\n".repeat((2_000_000 / 3) * 2)
  const fd = new FormData()
  fd.append("file", new Blob([pdf]), "big.pdf")
  fd.append("text", text)
  const req = new Request("http://x/", { method: "POST", body: fd })
  const formBytes = (await req.clone().arrayBuffer()).byteLength
  let peak = 0
  const tick = () => { const m = process.memoryUsage(); peak = Math.max(peak, m.arrayBuffers + m.heapUsed) }
  const reader = req.body!.getReader()
  const sampled = new ReadableStream<Uint8Array>({
    async pull(ctrl) { const { done, value } = await reader.read(); tick(); if (done) ctrl.close(); else ctrl.enqueue(value) },
  })
  gc()
  const base = process.memoryUsage()
  const result = await read(new Headers({ "content-type": req.headers.get("content-type")! }), sampled)
  tick()
  if (!result.ok) throw new Error("read failed")
  return {
    formMB: formBytes / MB,
    peakMB: (peak - base.arrayBuffers - base.heapUsed) / MB,
    fileMB: result.bytes.byteLength / MB,
    textLength: result.text.length,
  }
}

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

  it("reads the original and its text with one copy of the form fewer than before", async () => {
    // the reviewer's case: a 25 MB original and ~4 MB of CRLF text, the old
    // read (raw body, then the parse) kept here as the yardstick
    const old = await measure(oldReadPdfForm)
    const now = await measure(readPdfForm)
    console.log(`AQU-2551 KB memory: form=${now.formMB.toFixed(1)} MB; peak above baseline (heap+ArrayBuffers, Node): before ${old.peakMB.toFixed(0)} MB, now ${now.peakMB.toFixed(0)} MB; file=${now.fileMB.toFixed(1)} MB`)
    expect(now.fileMB).toBe(old.fileMB)
    expect(now.textLength).toBe(old.textLength)
    // the raw body and its joined copy are gone. Alone the gap is ~95 MB;
    // beside other test files Node collects sooner and it narrows to ~28 MB
    // (one form), so the bar is half a form.
    expect(now.peakMB).toBeLessThan(old.peakMB - now.formMB / 2)
  }, 60_000)
})
