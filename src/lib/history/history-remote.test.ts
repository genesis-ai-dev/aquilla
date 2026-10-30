// The server copy's client: a refusal for size is told apart from being
// offline, so the history trims itself instead of re-sending the same
// megabytes with every step (review, Oct 29).
import { afterEach, describe, expect, it, vi } from "vitest"
import { httpHistoryRemote } from "./history-remote"
import { emptyHistoryDoc } from "./history-merge"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("httpHistoryRemote.write", () => {
  it("answers tooLarge when the server refuses the body for its size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "too_large" } }), { status: 413 })))
    const remote = httpHistoryRemote(() => "jwt")
    expect(await remote.write("p1", 3, emptyHistoryDoc())).toEqual({ kind: "tooLarge" })
  })

  it("answers null when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    const remote = httpHistoryRemote(() => "jwt")
    expect(await remote.write("p1", 3, emptyHistoryDoc())).toBeNull()
  })
})
