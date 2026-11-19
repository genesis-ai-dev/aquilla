import { describe, expect, it } from "vitest"
import { CleanupStreamError, readCleanupReply } from "./stream"

/** An SSE response delivered in the given byte chunks, to cut frames anywhere. */
function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe("readCleanupReply", () => {
  // The row draws the cleanup as it is written, so each call must carry the
  // whole text so far, in order, whatever way the network cut the frames.
  it("reports the transcript as it grows and returns the result frame", async () => {
    const seen: string[] = []
    const body = frame("delta", { add: "ni " }) + frame("delta", { add: "Yesu" })
      + frame("result", { model: "m", result: { kind: "ok", text: "ni Yesu", notes: [], changes: 1 } })
    const cut = Math.floor(body.length / 3)
    const reply = await readCleanupReply(sse([body.slice(0, cut), body.slice(cut, cut * 2), body.slice(cut * 2)]), (t) => seen.push(t))
    expect(seen).toEqual(["ni ", "ni Yesu"])
    expect(reply).toEqual({ model: "m", result: { kind: "ok", text: "ni Yesu", notes: [], changes: 1 } })
  })

  // A server deployed before streaming answers JSON. The lens must keep
  // working against it; the web app and the worker do not deploy together.
  it("reads a plain JSON reply from a server that does not stream", async () => {
    const seen: string[] = []
    const res = new Response(JSON.stringify({ model: "m", result: { kind: "unchanged" } }), { headers: { "Content-Type": "application/json" } })
    expect(await readCleanupReply(res, (t) => seen.push(t))).toEqual({ model: "m", result: { kind: "unchanged" } })
    expect(seen).toEqual([])
  })

  // Half a transcript must never be saved as the cleanup.
  it("throws when the stream stops before its result, or carries an error", async () => {
    await expect(readCleanupReply(sse([frame("delta", { add: "ni Ye" })]))).rejects.toBeInstanceOf(CleanupStreamError)
    await expect(readCleanupReply(sse([frame("delta", { add: "ni" }), frame("error", { message: "boom" })])))
      .rejects.toThrow("boom")
  })
})
