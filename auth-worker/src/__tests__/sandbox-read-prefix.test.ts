import { describe, expect, it } from "vitest"
import { readPrefix } from "../lib/agent/sandbox-client"

// A sandbox file's size is chosen by code running in the container. The read
// keeps the prefix the caller asked for and stops the stream there, instead of
// buffering the whole body and slicing it afterwards.

const enc = new TextEncoder()

function responseOf(chunks: string[], onCancel?: () => void): { res: Response; left: string[] } {
  const left = [...chunks]
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = left.shift()
      if (next === undefined) controller.close()
      else controller.enqueue(enc.encode(next))
    },
    cancel() {
      onCancel?.()
    },
  })
  return { res: new Response(body), left }
}

describe("readPrefix", () => {
  it("returns the whole body when it fits", async () => {
    const { res } = responseOf(["abc", "def"])
    const out = await readPrefix(res, 6)
    expect(new TextDecoder().decode(out.bytes)).toBe("abcdef")
    expect(out.truncated).toBe(false)
  })

  it("keeps exactly maxBytes of a longer body and cancels the rest unread", async () => {
    let cancelled = false
    const { res, left } = responseOf(["abc", "defg", "never read"], () => (cancelled = true))
    const out = await readPrefix(res, 5)
    expect(new TextDecoder().decode(out.bytes)).toBe("abcde")
    expect(out.truncated).toBe(true)
    expect(cancelled).toBe(true)
    expect(left).toEqual(["never read"])
  })

  it("treats a bodiless response as empty", async () => {
    const out = await readPrefix(new Response(null), 5)
    expect(out.bytes.byteLength).toBe(0)
    expect(out.truncated).toBe(false)
  })
})
