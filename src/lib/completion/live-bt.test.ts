import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backtranslationSettings, createLiveBtQueue, needsLiveBacktranslation } from "./live-bt"
import type { BacktranslationRecord } from "./bt-record"
import type { CompletionSettings } from "@/lib/parsers/types"

const record = (over: Partial<BacktranslationRecord> = {}): BacktranslationRecord => ({
  cellId: "c1",
  btText: "in beginning God made",
  targetEventId: "e1",
  forText: "Au commencement Dieu créa",
  polished: true,
  createdAt: 1,
  ...over,
})

describe("needsLiveBacktranslation", () => {
  it("skips an empty translation", () => {
    expect(needsLiveBacktranslation({ translated: "  ", targetEventId: "e1", record: undefined })).toBe(false)
  })

  it("reads a translation that has no reading yet", () => {
    expect(needsLiveBacktranslation({ translated: "Au commencement", targetEventId: "e1", record: undefined })).toBe(true)
  })

  it("leaves a reading that already describes the text", () => {
    expect(needsLiveBacktranslation({
      translated: "Au commencement Dieu créa",
      targetEventId: "e2",
      record: record(),
    })).toBe(false)
  })

  it("re-reads an AI reading of older text", () => {
    expect(needsLiveBacktranslation({
      translated: "Au commencement Dieu fit",
      targetEventId: "e2",
      record: record(),
    })).toBe(true)
  })

  it("never replaces a hand-corrected reading, even when it is out of date", () => {
    expect(needsLiveBacktranslation({
      translated: "Au commencement Dieu fit",
      targetEventId: "e2",
      record: record({ polished: false }),
    })).toBe(false)
  })

  it("judges a server row (no forText) by its pin", () => {
    const row = record({ forText: "" })
    expect(needsLiveBacktranslation({ translated: "x", targetEventId: "e1", record: row })).toBe(false)
    expect(needsLiveBacktranslation({ translated: "x", targetEventId: "e9", record: row })).toBe(true)
  })
})

describe("backtranslationSettings", () => {
  const base = { model: "draft/model", endpoint: "", maxTokens: 100, temperature: 0.3, systemPrompt: "" } as CompletionSettings

  it("uses the drafting model when no back-translation model is set", () => {
    expect(backtranslationSettings(base).model).toBe("draft/model")
    expect(backtranslationSettings({ ...base, backtranslationModel: "  " }).model).toBe("draft/model")
  })

  it("swaps in the back-translation model and keeps everything else", () => {
    const out = backtranslationSettings({ ...base, backtranslationModel: "bt/model", provider: "custom", endpoint: "https://x" })
    expect(out).toMatchObject({ model: "bt/model", provider: "custom", endpoint: "https://x" })
  })
})

describe("createLiveBtQueue", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
  }

  it("reads a cell once after a burst of saves, with the newest commit id", async () => {
    const run = vi.fn(async () => {})
    const queue = createLiveBtQueue({ run, delayMs: 1000 })
    queue.notify("c1", "e1")
    await vi.advanceTimersByTimeAsync(500)
    queue.notify("c1", "e2")
    await vi.advanceTimersByTimeAsync(999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith("c1", "e2")
  })

  it("does not carry an older commit id onto a save that has none", async () => {
    const run = vi.fn(async () => {})
    const queue = createLiveBtQueue({ run, delayMs: 10 })
    queue.notify("c1", "e1")
    queue.notify("c1")
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledWith("c1", undefined)
  })

  it("runs at most `concurrency` readings at once", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>()
    const run = vi.fn((cellId: string) => {
      const d = deferred()
      gates.set(cellId, d)
      return d.promise
    })
    const queue = createLiveBtQueue({ run, delayMs: 0, concurrency: 2 })
    for (const id of ["a", "b", "c", "d"]) queue.notify(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.mock.calls.map((c) => c[0])).toEqual(["a", "b"])
    gates.get("a")!.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"])
  })

  it("reads a cell again when it is saved while its reading is in flight", async () => {
    const d = deferred()
    const run = vi.fn()
      .mockImplementationOnce(() => d.promise)
      .mockImplementation(async () => {})
    const queue = createLiveBtQueue({ run, delayMs: 0 })
    queue.notify("c1", "e1")
    await vi.advanceTimersByTimeAsync(0)
    queue.notify("c1", "e2")
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    d.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith("c1", "e2")
  })

  it("keeps going after a reading fails", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("no credits"))
      .mockResolvedValue(undefined)
    const queue = createLiveBtQueue({ run, delayMs: 0, concurrency: 1 })
    queue.notify("a")
    queue.notify("b")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.mock.calls.map((c) => c[0])).toEqual(["a", "b"])
  })

  it("drops everything waiting on cancelAll", async () => {
    const run = vi.fn(async () => {})
    const queue = createLiveBtQueue({ run, delayMs: 100 })
    queue.notify("c1")
    queue.cancelAll()
    await vi.advanceTimersByTimeAsync(200)
    expect(run).not.toHaveBeenCalled()
  })
})
