// AQU-2654: the progress store's side of "long work is honest about itself" —
// a run always ends in a terminal state that stays put, a silent run is
// flagged (and a slow-but-alive one never is), and a run cut off by a reload
// is reported on the next page load instead of being forgotten.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  getCompletionBatchProgress,
  resetBatchCompletionState,
  finishBatchCompletion,
  recordBatchCompletionDone,
  recordBatchCompletionFailed,
  noteBatchCompletionActivity,
  dismissBatchCompletionSummary,
  cancelBatchCompletion,
  isBatchCompletionCancelled,
  registerBatchCompletionResumer,
  resumeBatchCompletion,
  restoreInterruptedBatchCompletion,
  STALL_CEILING_MS,
} from "./batch-completion"

const IDS = ["a", "b", "c", "d"]
const SCOPE = { projectId: "p1", fileId: "f1", fileName: "Guide.docx" }

function start(ids: string[] = IDS) {
  return resetBatchCompletionState(ids.length, { cellIds: ids, scope: SCOPE })
}

beforeEach(() => {
  vi.useRealTimers()
  dismissBatchCompletionSummary()
  sessionStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  dismissBatchCompletionSummary()
})

describe("finishBatchCompletion — every exit is a terminal state that stays", () => {
  it("a fully drafted run ends as `done` and is NOT cleared", () => {
    const runId = start()
    recordBatchCompletionDone(runId, IDS)
    finishBatchCompletion(runId)

    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "done", total: 4, done: 4, failed: 0,
      remainingCellIds: [], scope: SCOPE,
    })
    expect(getCompletionBatchProgress()?.endedAt).not.toBeNull()
  })

  it("a stopped run ends as `stopped` with the never-attempted cells left to draft", () => {
    const runId = start()
    recordBatchCompletionDone(runId, ["a"])
    cancelBatchCompletion()
    finishBatchCompletion(runId)

    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "stopped", cancelled: false, done: 1,
      remainingCellIds: ["b", "c", "d"],
    })
  })

  it("failed cells are kept by name and stay in the remainder", () => {
    const runId = start()
    recordBatchCompletionDone(runId, ["a", "b"])
    recordBatchCompletionFailed(runId, [
      { cellId: "c", label: "GEN 1:3", reason: "Request timed out" },
      { cellId: "d", reason: "Request timed out" },
    ])
    finishBatchCompletion(runId)

    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "failed", done: 2, failed: 2,
      failedCells: [
        { cellId: "c", label: "GEN 1:3", reason: "Request timed out" },
        { cellId: "d", reason: "Request timed out" },
      ],
      remainingCellIds: ["c", "d"],
    })
  })

  it("a run that ends short with nothing recorded as failed is still `failed`, never `done`", () => {
    const runId = start()
    recordBatchCompletionDone(runId, ["a"])
    finishBatchCompletion(runId)
    expect(getCompletionBatchProgress()).toMatchObject({ outcome: "failed", done: 1, total: 4 })
  })

  it("the loop dying records why", () => {
    const runId = start()
    finishBatchCompletion(runId, { error: new Error("boom") })
    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "failed", runError: "boom", remainingCellIds: IDS,
    })
  })

  it("a superseded run cannot end the live run", () => {
    const oldRun = start()
    const liveRun = start()
    finishBatchCompletion(oldRun, { error: new Error("late") })
    expect(getCompletionBatchProgress()).toMatchObject({ runId: liveRun, finished: false, outcome: null })
  })

  it("a whole chunk is one store transition", () => {
    const runId = start()
    const before = getCompletionBatchProgress()
    recordBatchCompletionDone(runId, ["a", "b", "c"])
    const after = getCompletionBatchProgress()
    expect(after?.done).toBe(3)
    expect(after?.remainingCellIds).toEqual(["d"])
    // One replacement object, not three.
    recordBatchCompletionDone(runId, [])
    expect(getCompletionBatchProgress()).toBe(after)
    expect(after).not.toBe(before)
  })
})

describe("stall watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it("flags a run with no activity at all for the stall ceiling", () => {
    start()
    vi.advanceTimersByTime(STALL_CEILING_MS - 30_000)
    expect(getCompletionBatchProgress()?.stalled).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(getCompletionBatchProgress()?.stalled).toBe(true)
  })

  it("never fires on a slow-but-alive stream", () => {
    const runId = start()
    // 30 minutes of a delta every 100 s — slower than any real stream, and
    // nothing completes the whole time.
    for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += 100_000) {
      vi.advanceTimersByTime(100_000)
      noteBatchCompletionActivity(runId)
      expect(getCompletionBatchProgress()?.stalled).toBe(false)
    }
  })

  it("clears the flag as soon as the run moves again", () => {
    const runId = start()
    vi.advanceTimersByTime(STALL_CEILING_MS + 30_000)
    expect(getCompletionBatchProgress()?.stalled).toBe(true)
    noteBatchCompletionActivity(runId)
    expect(getCompletionBatchProgress()?.stalled).toBe(false)
  })

  it("does not blame the run for time the machine was asleep", () => {
    start()
    vi.advanceTimersByTime(60_000)
    // The clock jumps 40 minutes without a single timer firing in between.
    vi.setSystemTime(Date.now() + 40 * 60_000)
    vi.advanceTimersByTime(15_000)
    expect(getCompletionBatchProgress()?.stalled).toBe(false)
    // …but a further full ceiling of silence after waking is a stall.
    vi.advanceTimersByTime(STALL_CEILING_MS + 15_000)
    expect(getCompletionBatchProgress()?.stalled).toBe(true)
  })

  it("Stop on a stalled run ends it immediately and retires the hung loop", () => {
    const runId = start()
    recordBatchCompletionDone(runId, ["a"])
    vi.advanceTimersByTime(STALL_CEILING_MS + 30_000)
    expect(getCompletionBatchProgress()?.stalled).toBe(true)

    cancelBatchCompletion()

    // Terminal now — not "cancelling…" until a loop that may never return does.
    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "stopped", done: 1, remainingCellIds: ["b", "c", "d"],
    })
    // If the hung loop wakes up later it must not save, count or re-finish.
    expect(isBatchCompletionCancelled(runId)).toBe(true)
    recordBatchCompletionDone(runId, ["b"])
    finishBatchCompletion(runId)
    expect(getCompletionBatchProgress()).toMatchObject({ outcome: "stopped", done: 1 })
  })

  it("stops watching once the run is over", () => {
    const runId = start()
    recordBatchCompletionDone(runId, IDS)
    finishBatchCompletion(runId)
    vi.advanceTimersByTime(STALL_CEILING_MS * 3)
    expect(getCompletionBatchProgress()).toMatchObject({ outcome: "done", stalled: false })
  })
})

describe("leaving the page mid-run", () => {
  const unloadIsQuestioned = () => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it("asks before the tab is closed or reloaded while a run is live, and only then", () => {
    expect(unloadIsQuestioned()).toBe(false)
    const runId = start()
    expect(unloadIsQuestioned()).toBe(true)
    recordBatchCompletionDone(runId, IDS)
    finishBatchCompletion(runId)
    expect(unloadIsQuestioned()).toBe(false)
  })

  it("holds a Web Lock for exactly the lifetime of the run", async () => {
    const held = new Set<string>()
    const request = vi.fn((name: string, callback: () => Promise<void>) => {
      held.add(name)
      return callback().then(() => { held.delete(name) })
    })
    vi.stubGlobal("navigator", { ...navigator, locks: { request } })
    try {
      const runId = start()
      expect(request).toHaveBeenCalledTimes(1)
      expect(held.size).toBe(1)
      finishBatchCompletion(runId)
      await vi.waitFor(() => expect(held.size).toBe(0))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("retry / resume the remainder", () => {
  it("hands the cells the run left undone to the project's live driver", () => {
    const resumer = vi.fn(() => true)
    const unregister = registerBatchCompletionResumer("p1", resumer)
    const runId = start()
    recordBatchCompletionDone(runId, ["a"])
    recordBatchCompletionFailed(runId, [{ cellId: "b", reason: "x" }])
    finishBatchCompletion(runId)

    expect(resumeBatchCompletion()).toBe(true)
    expect(resumer).toHaveBeenCalledWith(["b", "c", "d"])

    unregister()
    expect(resumeBatchCompletion()).toBe(false)
  })

  it("reports false when no driver for that project is mounted", () => {
    const other = vi.fn(() => true)
    const unregister = registerBatchCompletionResumer("another-project", other)
    const runId = start()
    finishBatchCompletion(runId, { error: new Error("boom") })
    expect(resumeBatchCompletion()).toBe(false)
    expect(other).not.toHaveBeenCalled()
    unregister()
  })
})

describe("a run cut off by a reload", () => {
  it("is reported as interrupted on the next page load, with the remainder", async () => {
    const runId = start()
    recordBatchCompletionDone(runId, ["a", "b"])
    const persisted = sessionStorage.getItem("aquilla.batchCompletion.v1")
    expect(persisted).not.toBeNull()

    // The page goes away mid-run: module state is gone, sessionStorage is not.
    vi.resetModules()
    sessionStorage.setItem("aquilla.batchCompletion.v1", persisted ?? "")
    const reloaded = await import("./batch-completion")
    expect(reloaded.getCompletionBatchProgress()).toBeNull()
    await reloaded.restoreInterruptedBatchCompletion()

    expect(reloaded.getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "interrupted", total: 4, done: 2,
      remainingCellIds: ["c", "d"], scope: SCOPE,
    })
    // Dismissing it forgets it for good.
    reloaded.dismissBatchCompletionSummary()
    expect(sessionStorage.getItem("aquilla.batchCompletion.v1")).toBeNull()
  })

  it("a run that reached a terminal state leaves nothing to restore", async () => {
    const runId = start()
    recordBatchCompletionDone(runId, IDS)
    finishBatchCompletion(runId)
    expect(sessionStorage.getItem("aquilla.batchCompletion.v1")).toBeNull()

    dismissBatchCompletionSummary()
    await restoreInterruptedBatchCompletion()
    expect(getCompletionBatchProgress()).toBeNull()
  })
})
