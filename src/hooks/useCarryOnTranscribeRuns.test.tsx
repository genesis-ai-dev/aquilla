// AQU-2375: a run a page reload stopped is carried on by the page that opens
// its file, by itself, once that file has loaded; elsewhere it is said once.

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  STALE_MS,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  startStoredTranscribeRun,
} from "@/lib/audio/transcribe-runs"
import { CARRY_ON_SETTLE_MS, useCarryOnTranscribeRuns } from "./useCarryOnTranscribeRuns"

let clock = 5_000_000

/** A run started by an earlier page, which then reloaded. */
function leaveStoppedRun(fileId = "f1") {
  __setTranscribeRunEnvForTests({ tab: "old-page", now: () => clock, locks: null })
  startStoredTranscribeRun({
    id: `run-${fileId}`, projectId: "p1", fileId, fileName: `${fileId}.mp3`, kind: "import",
    cellIds: ["a", "b"], force: false,
  })
  vi.clearAllTimers()
  clock += STALE_MS
  __setTranscribeRunEnvForTests({ tab: "new-page" })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  clock = 5_000_000
})
afterEach(() => vi.useRealTimers())

describe("useCarryOnTranscribeRuns", () => {
  it("carries the open file's stopped run on, once its rows have loaded", async () => {
    leaveStoppedRun("f1")
    const carryOn = vi.fn((_run, handle: { end: () => void }) => handle.end())
    const announce = vi.fn()
    const { rerender } = renderHook((p: { ready: boolean }) => useCarryOnTranscribeRuns({
      projectId: "p1", activeFileId: "f1", ready: p.ready, version: p.ready, carryOn, announce,
    }), { initialProps: { ready: false } })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS * 3) })
    // Not before the rows and recordings are in: a row to do can't be told
    // from a row with nothing on it yet.
    expect(carryOn).not.toHaveBeenCalled()
    rerender({ ready: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(carryOn).toHaveBeenCalledTimes(1)
    expect(carryOn.mock.calls[0]![0]).toMatchObject({ id: "run-f1", fileName: "f1.mp3" })
    expect(announce).not.toHaveBeenCalled()
    expect(__storedTranscribeRuns()).toEqual([])
  })

  it("says a run on another file once, and leaves it for that file", async () => {
    leaveStoppedRun("f2")
    const carryOn = vi.fn()
    const announce = vi.fn()
    const { rerender } = renderHook((p: { v: number }) => useCarryOnTranscribeRuns({
      projectId: "p1", activeFileId: "f1", ready: true, version: p.v, carryOn, announce,
    }), { initialProps: { v: 0 } })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    rerender({ v: 1 })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce.mock.calls[0]![0]).toMatchObject({ id: "run-f2" })
    expect(carryOn).not.toHaveBeenCalled()
    expect(__storedTranscribeRuns()).toHaveLength(1)
  })
})
