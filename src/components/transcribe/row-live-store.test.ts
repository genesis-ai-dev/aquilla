// The per-row store behind the Transcribe lens (AQU-2654). What it has to
// guarantee: a row's step reaches that row's listeners only, a change of stage
// is never delayed, and the tokens of a streaming cleanup cost one update per
// frame however many arrive.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRowLiveStore, type RowStatus } from "./row-live-store"

const writing = (text: string): RowStatus => ({ kind: "working", progress: { stage: "cleaning", heard: "eema akasema", text } })

describe("row-live-store", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("tells only the row that changed", () => {
    const store = createRowLiveStore()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe("a", a)
    store.subscribe("b", b)
    store.setStatus("a", { kind: "working", progress: { stage: "listening" } })
    store.setLive("a", { heard: "eema" })
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).not.toHaveBeenCalled()
    // Untouched rows keep reading the one idle entry: no new object per read.
    expect(store.get("b")).toBe(store.get("c"))
  })

  it("lands a change of stage at once, and the first text of a cleanup with it", () => {
    const store = createRowLiveStore()
    const seen = vi.fn()
    store.subscribe("a", seen)
    store.setStatus("a", { kind: "working", progress: { stage: "listening" } })
    store.setStatus("a", writing(""))
    expect(seen).toHaveBeenCalledTimes(2)
    expect(store.get("a").status).toEqual(writing(""))
  })

  it("takes a streaming cleanup's tokens once per frame, newest text winning", () => {
    const store = createRowLiveStore()
    const seen = vi.fn()
    store.setStatus("a", writing(""))
    store.subscribe("a", seen)
    for (let i = 1; i <= 40; i++) store.setStatus("a", writing("Yesu ".repeat(i)))
    // Forty tokens inside one frame: nothing has been announced yet.
    expect(seen).not.toHaveBeenCalled()
    expect(store.get("a").status).toEqual(writing(""))
    vi.advanceTimersToNextFrame()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(store.get("a").status).toEqual(writing("Yesu ".repeat(40)))
  })

  it("does not let a held token overwrite the outcome that followed it", () => {
    const store = createRowLiveStore()
    store.setStatus("a", writing(""))
    store.setStatus("a", writing("Yesu"))
    store.setStatus("a", { kind: "failed", step: "cleanup", detail: "502" })
    vi.advanceTimersToNextFrame()
    expect(store.get("a").status).toEqual({ kind: "failed", step: "cleanup", detail: "502" })
  })

  it("keeps what a row shows ahead of its data until it is dropped", () => {
    const store = createRowLiveStore()
    store.setLive("a", { heard: "eema" })
    store.setLive("a", { transcript: "Yesu", aiCleaned: true })
    expect(store.get("a").live).toEqual({ heard: "eema", transcript: "Yesu", aiCleaned: true })
    store.setStatus("a", { kind: "unchanged" })
    expect(store.get("a").live).toEqual({ heard: "eema", transcript: "Yesu", aiCleaned: true })
    store.setLive("a", null)
    expect(store.get("a")).toEqual({ status: { kind: "unchanged" } })
  })

  it("announces a pass's progress to its own listeners, not to the rows", () => {
    const store = createRowLiveStore()
    const row = vi.fn()
    const bar = vi.fn()
    store.subscribe("a", row)
    store.subscribeBatch(bar)
    store.setBatch({ done: 0, total: 3 })
    store.setBatch((b) => b && { ...b, done: b.done + 1 })
    expect(store.getBatch()).toEqual({ done: 1, total: 3 })
    expect(bar).toHaveBeenCalledTimes(2)
    expect(row).not.toHaveBeenCalled()
  })
})
