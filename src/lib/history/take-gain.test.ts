// AQU-2327: a take's volume and fades undo as one step, and leave alone a
// level someone has changed since.
import { describe, expect, it, vi } from "vitest"
import { takeStepHandlers, type TakeGainData, type TakeStepContext } from "./take-steps"

function ctxWith(att: Record<string, unknown> | null) {
  const applyGain = vi.fn(async () => {})
  const ctx = {
    readTake: () => att,
    selectedIn: () => null,
    applyTrim: async () => {},
    applyGain,
    applyPlace: async () => {},
    cut: async () => true,
    uncut: async () => {},
    newPieceId: () => "x",
    select: async () => {},
    remove: async () => {},
    rename: async () => {},
  } as unknown as TakeStepContext
  return { ctx, applyGain }
}

const data: TakeGainData = {
  cellId: "c",
  audioId: "a",
  before: { gainDb: null, fadeInMs: null, fadeOutMs: null },
  after: { gainDb: -3, fadeInMs: 300, fadeOutMs: null },
}

describe("take.gain", () => {
  it("undo puts the old level back", async () => {
    const { ctx, applyGain } = ctxWith({ url: "u", type: "audio", gainDb: -3, fadeInMs: 300 })
    const out = await (takeStepHandlers(ctx)["take.gain"] as unknown as { undo(d: TakeGainData): Promise<{ kind: string }> }).undo(data)
    expect(out.kind).toBe("done")
    expect(applyGain).toHaveBeenCalledWith("c", "a", data.before)
  })

  it("skips a level someone changed since", async () => {
    const { ctx, applyGain } = ctxWith({ url: "u", type: "audio", gainDb: 2 })
    const out = await (takeStepHandlers(ctx)["take.gain"] as unknown as { undo(d: TakeGainData): Promise<{ kind: string; reason?: string }> }).undo(data)
    expect(out).toMatchObject({ kind: "skipped", reason: "changed" })
    expect(applyGain).not.toHaveBeenCalled()
  })
})
