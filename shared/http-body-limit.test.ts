// Request-body size gates (AQU-1858).
//
// The point of these helpers is what they *don't* do: a body over the ceiling
// must cost the isolate nothing, so every test here asserts on how much of the
// stream was pulled, not only on the status that came back.

import { describe, expect, it } from "vitest"

import {
  declaresOversizeBody,
  readBytesWithLimit,
  readTextBodyWithLimit,
} from "./http-body-limit"

function headers(values: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => values[name.toLowerCase()] ?? null }
}

/** A body stream that counts how many chunks were pulled out of it. */
function countedBody(chunks: string[]): {
  body: ReadableStream<Uint8Array>
  pulled: () => number
  cancelled: () => boolean
} {
  const encoder = new TextEncoder()
  let pulled = 0
  let cancelled = false
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) {
        controller.close()
        return
      }
      pulled += 1
      controller.enqueue(encoder.encode(chunks[next]))
      next += 1
    },
    cancel() {
      cancelled = true
    },
  // highWaterMark 0: no chunk is pulled until the reader asks, so `pulled()`
  // measures what the gate actually read rather than the stream's pre-fill.
  }, new CountQueuingStrategy({ highWaterMark: 0 }))
  return { body, pulled: () => pulled, cancelled: () => cancelled }
}

describe("declaresOversizeBody", () => {
  it("refuses a declared length over the ceiling", () => {
    expect(declaresOversizeBody(headers({ "content-length": "101" }), 100)).toBe(true)
  })

  it("accepts a declared length at the ceiling", () => {
    expect(declaresOversizeBody(headers({ "content-length": "100" }), 100)).toBe(false)
  })

  it("does not refuse on a missing, empty, or unparseable length", () => {
    expect(declaresOversizeBody(headers({}), 100)).toBe(false)
    expect(declaresOversizeBody(headers({ "content-length": "" }), 100)).toBe(false)
    expect(declaresOversizeBody(headers({ "content-length": "many" }), 100)).toBe(false)
  })
})

describe("readTextBodyWithLimit", () => {
  it("refuses an oversize Content-Length without pulling the body", async () => {
    const { body, pulled } = countedBody(["a".repeat(50), "b".repeat(50)])
    const result = await readTextBodyWithLimit(
      headers({ "content-length": "100" }),
      body,
      10,
    )
    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "request body exceeds the 10-byte limit",
      maxBytes: 10,
    })
    expect(pulled()).toBe(0)
  })

  it("caps a chunked body that declares no length, and cancels the stream", async () => {
    // The evasion the Content-Length check alone would miss: drop the header
    // and stream the same oversize payload.
    const { body, pulled, cancelled } = countedBody(["12345", "67890", "abcde", "fghij"])
    const result = await readTextBodyWithLimit(headers({}), body, 10)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.status).toBe(413)
    // Stopped at the chunk that crossed the limit — it did not drain the rest.
    expect(pulled()).toBe(3)
    expect(cancelled()).toBe(true)
  })

  it("reads a body at the limit, across chunk boundaries", async () => {
    const { body } = countedBody(["hello ", "world"])
    const result = await readTextBodyWithLimit(headers({}), body, 11)
    expect(result).toEqual({ ok: true, text: "hello world" })
  })

  it("decodes multi-byte characters split across chunks", async () => {
    // "é" is two UTF-8 bytes; a non-streaming decode per chunk would corrupt it.
    const encoded = new TextEncoder().encode("café")
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= encoded.length) {
          controller.close()
          return
        }
        controller.enqueue(encoded.slice(pulled, pulled + 1))
        pulled += 1
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }))
    const result = await readTextBodyWithLimit(headers({}), body, 100)
    expect(result).toEqual({ ok: true, text: "café" })
  })

  it("reads a null body as empty text", async () => {
    expect(await readTextBodyWithLimit(headers({}), null, 10)).toEqual({ ok: true, text: "" })
  })
})

describe("readBytesWithLimit", () => {
  it("refuses an oversize Content-Length without pulling the body", async () => {
    const { body, pulled } = countedBody(["payload"])
    const result = await readBytesWithLimit(headers({ "content-length": "4096" }), body, 1024)
    expect(result.ok).toBe(false)
    expect(pulled()).toBe(0)
  })

  it("caps a chunked body and cancels the stream", async () => {
    const { body, cancelled } = countedBody(["1234", "5678", "9012"])
    const result = await readBytesWithLimit(headers({}), body, 6)
    expect(result.ok).toBe(false)
    expect(cancelled()).toBe(true)
  })

  it("concatenates chunks in order up to the limit", async () => {
    const { body } = countedBody(["ab", "cd", "ef"])
    const result = await readBytesWithLimit(headers({}), body, 6)
    if (!result.ok) throw new Error("expected a successful read")
    expect(new TextDecoder().decode(result.bytes)).toBe("abcdef")
    expect(result.bytes.byteLength).toBe(6)
  })

  it("reads a null body as zero bytes", async () => {
    const result = await readBytesWithLimit(headers({}), null, 10)
    if (!result.ok) throw new Error("expected a successful read")
    expect(result.bytes.byteLength).toBe(0)
  })
})
