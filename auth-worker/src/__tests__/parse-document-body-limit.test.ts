// parse-document — upload size gate (AQU-1858)
//
// The route used to call c.req.formData() before it applied the 2 MB
// MAX_FILE_BYTES rule, so an authenticated caller could make the Worker
// materialize an arbitrarily large multipart body for an upload that was
// always going to be refused. The gate now runs first: an oversize
// Content-Length is refused from the headers alone, and a chunked body with
// no declared length is read through the same byte cap.
//
// authMiddleware is stubbed here — this file is about what happens *after*
// the caller is known. The streaming cap itself is covered at its own
// boundary in shared/http-body-limit.test.ts.

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi } from "vitest"
import { zipSync, zlibSync, strToU8 } from "fflate"

vi.mock("../middleware/auth", () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: 1 })
    await next()
  },
}))

vi.mock("../../../db/shared/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true, hits: 1, limit: 1, retryAfterSeconds: 0, degraded: false }),
  userRateLimitIdentifier: (id: number) => `user:${id}`,
}))

const parseDocumentApp = (await import("../routes/parse-document")).default
// The route reads c.env.AQUILLA_PG for the (mocked) rate limiter.
const parseDocument = {
  request: (path: string, init?: RequestInit) =>
    parseDocumentApp.request(path, init, { AQUILLA_PG: {} }),
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 16 * 1024

function makeDocx(paragraphs: string[]): Uint8Array {
  const runs = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${runs.join("")}</w:body></w:document>`
  return zipSync({ "word/document.xml": strToU8(xml) })
}

/** A multipart body stream that records whether anything was pulled from it. */
function unreadableMultipart(): {
  body: ReadableStream<Uint8Array>
  pulled: () => boolean
} {
  let pulled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled = true
      controller.enqueue(new TextEncoder().encode("--b--\r\n"))
      controller.close()
    },
  }, new CountQueuingStrategy({ highWaterMark: 0 }))
  return { body, pulled: () => pulled }
}

describe("POST /api/v2/parse-document — upload gate (AQU-1858)", () => {
  it("refuses an oversize Content-Length with 413 without reading the body", async () => {
    const { body, pulled } = unreadableMultipart()

    const res = await parseDocument.request("/", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=b",
        "content-length": String(MAX_UPLOAD_BYTES + 1),
      },
      body,
      duplex: "half",
    } as RequestInit)

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: "File too large. Maximum is 2 MB." })
    expect(pulled()).toBe(false)
  })

  it("caps a chunked upload that declares no length", async () => {
    // 3 MB streamed in 512 KB chunks, no Content-Length to check against.
    const chunk = new Uint8Array(512 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 6) {
          controller.close()
          return
        }
        sent += 1
        controller.enqueue(chunk)
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }))

    const res = await parseDocument.request("/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=b" },
      body,
      duplex: "half",
    } as RequestInit)

    expect(res.status).toBe(413)
    // Stopped as soon as the cap was crossed rather than draining all 3 MB.
    expect(sent).toBeLessThan(6)
  })

  it("still parses an upload inside the limit", async () => {
    const form = new FormData()
    form.append(
      "file",
      new File([makeDocx(["Hello world"])], "notes.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    )

    const res = await parseDocument.request("/", { method: "POST", body: form })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: "Hello world" })
  })

  it("still rejects a non-multipart body with 400", async () => {
    const res = await parseDocument.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "nope" }),
    })

    expect(res.status).toBe(400)
  })
})

// AQU-2551 review findings 1–3: the server no longer reads PDFs (a 2 MB
// upload could make it decode a gigabyte). The app reads a PDF in the browser
// and sends only its text; a PDF sent here is refused with a code the client
// words, before a byte of it is decoded.
describe("POST /api/v2/parse-document — PDFs (AQU-2551)", () => {
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/lib/parsers/__fixtures__/pdf", name)))
  const post = (bytes: Uint8Array, name: string, type = "application/pdf") => {
    const form = new FormData()
    form.append("file", new File([bytes], name, { type }))
    return parseDocument.request("/", { method: "POST", body: form })
  }

  it("refuses a PDF with code \"pdf-text-required\"", async () => {
    const res = await post(fixture("two-column.pdf"), "rules.pdf")
    expect(res.status).toBe(415)
    expect(((await res.json()) as { code?: string }).code).toBe("pdf-text-required")
  })

  it("refuses a PDF known only by its type", async () => {
    const res = await post(fixture("two-column.pdf"), "rules", "application/pdf")
    expect(res.status).toBe(415)
  })

  // The reviewer's bomb: a filter name pdf.js decodes and the old check
  // missed (`/Fl`), 60 MB of text operators from a small upload.
  it("refuses the review's decompression bomb at once, without decoding it", async () => {
    const ops = strToU8("BT /F1 1 Tf " + "(abcdefghij) Tj ".repeat(3_750_000) + " ET")
    const data = zlibSync(ops, { level: 9 })
    const bomb = new Uint8Array([
      ...strToU8(`%PDF-1.7\n1 0 obj\n<< /Length ${data.length} /Filter /Fl >>\nstream\n`),
      ...data,
      ...strToU8("\nendstream\nendobj\n%%EOF\n"),
    ])
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024)
    const t0 = performance.now()
    const res = await post(bomb, "bomb.pdf")
    expect(res.status).toBe(415)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
