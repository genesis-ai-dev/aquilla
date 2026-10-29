// Decision 11 (P13.5): editing a line's source text is one Undo step per
// editing session, chained on the line's source head.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { settleSourceStep, sourceStepHandlers, type SourceStepContext, type SourceTextData } from "./source-steps"
import { historyView, resetHistoryForTests, setHistoryScope } from "./history"
import type { StepHandler } from "./history"

function line(start: { value: string; eventId: string }) {
  const state = { ...start }
  let n = 0
  const ctx: SourceStepContext = {
    readSource: () => state,
    commitSource: vi.fn(async (_cellId, text, parentId) => {
      n += 1
      state.value = text.value
      state.eventId = `undo-${n}`
      return parentId ? state.eventId : null
    }),
  }
  return { state, ctx, handlers: sourceStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
}

const step = (): SourceTextData => ({
  cellId: "sub3",
  before: { value: "In the beginning" },
  after: { value: "In the very beginning" },
  heads: ["e0", "e1", "e2"],
})

describe("source.text", () => {
  it("undo commits the old text on the newest head, and redo commits the new text on the undo", async () => {
    const { state, ctx, handlers } = line({ value: "In the very beginning", eventId: "e2" })
    const data = step()
    expect(await handlers["source.text"].undo(data)).toEqual({ kind: "done" })
    expect(ctx.commitSource).toHaveBeenLastCalledWith("sub3", { value: "In the beginning" }, "e2")
    expect(state.value).toBe("In the beginning")
    expect(await handlers["source.text"].redo(data)).toEqual({ kind: "done" })
    expect(ctx.commitSource).toHaveBeenLastCalledWith("sub3", { value: "In the very beginning" }, "undo-1")
  })

  it("runs while the projection still shows one of the session's own heads", async () => {
    const { handlers } = line({ value: "In the beg", eventId: "e1" })
    expect(await handlers["source.text"].undo(step())).toEqual({ kind: "done" })
  })

  it("is skipped once someone else has edited the line since", async () => {
    const { ctx, handlers } = line({ value: "Someone else's text", eventId: "theirs" })
    expect(await handlers["source.text"].undo(step())).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.commitSource).not.toHaveBeenCalled()
  })
})

describe("one editing session, one step", () => {
  beforeEach(() => {
    resetHistoryForTests()
    setHistoryScope("p1", "sam", "fr")
  })

  it("is recorded once its saves are queued, and belongs to no language", async () => {
    await settleSourceStep(
      { before: { value: "a" }, after: { value: "b" }, heads: ["e0", "e1"], writes: [Promise.resolve(true)] },
      { cellId: "sub3", fileId: "ep2" },
    )
    const [only] = historyView().undoSteps
    expect(only).toMatchObject({ labelKey: "editor.history.stepEditSource", fileId: "ep2" })
    expect(only.lane).toBeUndefined()
  })

  it("records nothing when the text ends as it began, or no save was queued", async () => {
    await settleSourceStep({ before: { value: "a" }, after: { value: "a" }, heads: [], writes: [Promise.resolve(true)] }, { cellId: "c", fileId: "f" })
    await settleSourceStep({ before: { value: "a" }, after: { value: "b" }, heads: [], writes: [Promise.resolve(false)] }, { cellId: "c", fileId: "f" })
    expect(historyView().undoSteps).toEqual([])
  })
})
