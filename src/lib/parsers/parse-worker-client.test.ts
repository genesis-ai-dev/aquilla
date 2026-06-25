import { describe, it, expect } from "vitest"
import { parseTextFormatOffMainThread } from "./parse-worker-client"
import { parseTextFormat, type TextParseRequest } from "./parse-text-formats"

const txtReq: TextParseRequest = { fileType: "txt", text: "Hello.\n\nWorld.", name: "a.txt" }

/** A minimal stand-in for a dedicated Worker that runs `handler` on postMessage
 *  and dispatches the reply (or an error) back through onmessage/onerror. */
function fakeWorker(handler: (req: TextParseRequest) => unknown): Worker {
  const w = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    postMessage(req: TextParseRequest) {
      queueMicrotask(() => {
        try {
          const data = handler(req)
          w.onmessage?.({ data } as MessageEvent)
        } catch (err) {
          w.onerror?.({ message: err instanceof Error ? err.message : String(err) })
        }
      })
    },
    terminate() {},
  }
  return w as unknown as Worker
}

describe("parseTextFormatOffMainThread", () => {
  it("resolves with the worker's parsed results", async () => {
    const worker = fakeWorker((req) => ({ ok: true, results: parseTextFormat(req) }))
    const results = await parseTextFormatOffMainThread(txtReq, async () => worker)
    expect(results[0].name).toBe("a.txt")
    expect(results[0].strings.length).toBeGreaterThan(0)
  })

  it("falls back to inline parsing when no worker can be created", async () => {
    const results = await parseTextFormatOffMainThread(txtReq, async () => null)
    expect(results[0].name).toBe("a.txt")
    expect(results[0].strings.length).toBeGreaterThan(0)
  })

  it("falls back to inline parsing when the worker crashes", async () => {
    const worker = fakeWorker(() => {
      throw new Error("worker boom")
    })
    const results = await parseTextFormatOffMainThread(txtReq, async () => worker)
    // Import must not break just because the worker failed — inline parse wins.
    expect(results[0].strings.length).toBeGreaterThan(0)
  })

  it("rejects when the worker reports a genuine parse failure", async () => {
    const worker = fakeWorker(() => ({ ok: false, error: "bad input" }))
    await expect(parseTextFormatOffMainThread(txtReq, async () => worker)).rejects.toThrow(
      /bad input/,
    )
  })
})
