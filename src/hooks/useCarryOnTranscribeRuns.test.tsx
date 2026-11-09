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
import { CARRY_ON_SETTLE_MS, carryOnReady, useCarryOnTranscribeRuns } from "./useCarryOnTranscribeRuns"

let clock = 5_000_000

/** A run started by an earlier page, which then reloaded. */
function leaveStoppedRun(fileId = "f1", who: { username?: string; lane?: string; kind?: "import" | "all" | "lineWords" } = {}) {
  __setTranscribeRunEnvForTests({ tab: "old-page", now: () => clock, locks: null })
  startStoredTranscribeRun({
    id: `run-${fileId}`, projectId: "p1", fileId, fileName: `${fileId}.mp3`, kind: who.kind ?? "import",
    cellIds: ["a", "b"], force: false,
    ...(who.username !== undefined ? { username: who.username } : {}),
    ...(who.lane !== undefined ? { lane: who.lane } : {}),
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

  // AQU-2375 (review, Nov 9): a run belongs to the person who started it and,
  // for takes, to the language it was started in.
  it("leaves a run someone else started on this computer alone, and says nothing", async () => {
    leaveStoppedRun("f1", { username: "amina" })
    leaveStoppedRun("f2", { username: "amina" })
    const carryOn = vi.fn()
    const announce = vi.fn()
    renderHook(() => useCarryOnTranscribeRuns({
      projectId: "p1", activeFileId: "f1", ready: true, version: 0, username: "baraka", lane: "", carryOn, announce,
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(carryOn).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(__storedTranscribeRuns()).toHaveLength(2)
  })

  it("a run started in another language waits for that language: said once, carried on when it is opened", async () => {
    leaveStoppedRun("f1", { username: "amina", lane: "fr", kind: "all" })
    const carryOn = vi.fn((_run, handle: { end: () => void }) => handle.end())
    const announce = vi.fn()
    const { rerender } = renderHook((p: { lane: string; v: number }) => useCarryOnTranscribeRuns({
      projectId: "p1", activeFileId: "f1", ready: true, version: p.v, username: "amina", lane: p.lane, carryOn, announce,
    }), { initialProps: { lane: "sw", v: 0 } })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    rerender({ lane: "sw", v: 1 })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(carryOn).not.toHaveBeenCalled()
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce.mock.calls[0]).toMatchObject([{ id: "run-f1" }, "lane"])
    rerender({ lane: "fr", v: 1 })
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(carryOn).toHaveBeenCalledTimes(1)
  })

  it("a line's words run is the source recording's: carried on in any language", async () => {
    leaveStoppedRun("f1", { username: "amina", lane: "fr", kind: "lineWords" })
    const carryOn = vi.fn((_run, handle: { end: () => void }) => handle.end())
    renderHook(() => useCarryOnTranscribeRuns({
      projectId: "p1", activeFileId: "f1", ready: true, version: 0, username: "amina", lane: "sw", carryOn, announce: vi.fn(),
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(carryOn).toHaveBeenCalledTimes(1)
  })

  it("a run kept before runs named their person is carried on as before", async () => {
    leaveStoppedRun("f1")
    const carryOn = vi.fn((_run, handle: { end: () => void }) => handle.end())
    renderHook(() => useCarryOnTranscribeRuns({
      projectId: "p1", activeFileId: "f1", ready: true, version: 0, username: "baraka", lane: "sw", carryOn, announce: vi.fn(),
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
    expect(carryOn).toHaveBeenCalledTimes(1)
  })

  // AQU-2375 (review, Nov 9): a long file's rows arrive in pages (500, then
  // 2,000 at a time). "First paint" is the first page; a run carried on then
  // drops every row not in yet and reports them as never reached.
  describe("a long file whose later rows are slow to arrive", () => {
    const loading = { firstPaint: true, rowsLoading: true, recordingsLoaded: true, heardLinesLoading: false }

    it("is not ready while rows are still loading, however long a page takes", async () => {
      expect(carryOnReady(loading)).toBe(false)
      expect(carryOnReady({ ...loading, rowsLoading: false })).toBe(true)
      expect(carryOnReady({ ...loading, rowsLoading: false, firstPaint: false })).toBe(false)
      expect(carryOnReady({ ...loading, rowsLoading: false, recordingsLoaded: false })).toBe(false)
      expect(carryOnReady({ ...loading, rowsLoading: false, heardLinesLoading: true })).toBe(false)

      leaveStoppedRun("f1")
      const carryOn = vi.fn((_run, handle: { end: () => void }) => handle.end())
      const { rerender } = renderHook((p: { rowsLoading: boolean; rows: number }) => useCarryOnTranscribeRuns({
        projectId: "p1", activeFileId: "f1", ready: carryOnReady({ ...loading, rowsLoading: p.rowsLoading }), version: p.rows, carryOn, announce: vi.fn(),
      }), { initialProps: { rowsLoading: true, rows: 500 } })
      // The second page takes longer than the settle wait.
      await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS * 2) })
      expect(carryOn).not.toHaveBeenCalled()
      rerender({ rowsLoading: false, rows: 900 })
      await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS + 100) })
      expect(carryOn).toHaveBeenCalledTimes(1)
    })

    it("(why) first paint plus recordings, the old rule, carries on with the first page only", async () => {
      leaveStoppedRun("f1")
      const carryOn = vi.fn((_run, handle: { end: () => void }) => handle.end())
      renderHook(() => useCarryOnTranscribeRuns({
        projectId: "p1", activeFileId: "f1", ready: loading.firstPaint && loading.recordingsLoaded && !loading.heardLinesLoading, version: 500, carryOn, announce: vi.fn(),
      }))
      await act(async () => { await vi.advanceTimersByTimeAsync(CARRY_ON_SETTLE_MS * 2) })
      expect(carryOn).toHaveBeenCalledTimes(1)
    })
  })
})
