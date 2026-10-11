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

import { describe, it, expect, vi } from "vitest"
import { zipSync, strToU8 } from "fflate"

vi.mock("../middleware/auth", () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

const parseDocument = (await import("../routes/parse-document")).default

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
