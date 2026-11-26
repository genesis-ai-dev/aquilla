// AQU-2664 (re-check): Even out over 300 takes sends every write before it
// ends — rounds of the outbox until its own events are out — instead of one
// batch of 100 and the rest left to the background flusher.
import { describe, expect, it, vi } from "vitest"
import { flushEvenOutWrites, OUTBOX_BATCH } from "./even-out-flush"

describe("flushing Even out's writes", () => {
  it("asks for enough rounds to send them all", async () => {
    const settle = vi.fn(async () => ({ settled: true }))
    const ids = Array.from({ length: 300 }, (_, i) => `e${i}`)
    await flushEvenOutWrites(ids, { getTokenForFile: async () => "t" } as never, settle as never)
    expect(settle).toHaveBeenCalledWith(ids, expect.anything(), { maxRounds: Math.ceil(300 / OUTBOX_BATCH) + 2 })
  })

  it("does nothing when nothing was written", async () => {
    const settle = vi.fn()
    await flushEvenOutWrites([], {} as never, settle as never)
    expect(settle).not.toHaveBeenCalled()
  })

  it("a flush that fails is not the action's failure (the outbox sends it later)", async () => {
    const settle = vi.fn(async () => { throw new Error("offline") })
    await expect(flushEvenOutWrites(["e1"], {} as never, settle as never)).resolves.toBeUndefined()
  })
})
