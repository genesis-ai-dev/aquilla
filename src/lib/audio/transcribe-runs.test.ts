// AQU-2375: a transcription run's record outlives the page, and only a page
// that is gone leaves a run to be carried on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  HEARTBEAT_MS,
  MAX_AGE_MS,
  STALE_MS,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  claimStoredTranscribeRun,
  interruptedTranscribeRuns,
  startStoredTranscribeRun,
  type LockManagerLike,
} from "./transcribe-runs"

let clock = 1_000_000
const start = (id = "run-1") => startStoredTranscribeRun({
  id,
  projectId: "p1",
  fileId: "f1",
  fileName: "Session 4.mp3",
  kind: "import",
  cellIds: ["a", "b", "c"],
  force: false,
  sourceLanguage: "en",
})

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  clock = 1_000_000
  __setTranscribeRunEnvForTests({ tab: "page-1", now: () => clock, locks: null })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("a kept run", () => {
  it("is stored while it runs, records each row, and is forgotten when it ends", async () => {
    const run = start()
    expect(__storedTranscribeRuns()).toHaveLength(1)
    run.row("a", { kind: "done" })
    run.row("b", { kind: "failed", message: "HTTP 500" })
    run.row("c", { kind: "skipped" })
    await vi.advanceTimersByTimeAsync(1_000)
    const [stored] = __storedTranscribeRuns()
    expect(stored!.doneIds).toEqual(["a"])
    expect(stored!.failed).toEqual([{ cellId: "b", message: "HTTP 500" }])
    run.end()
    expect(__storedTranscribeRuns()).toEqual([])
  })

  it("a row retried after failing moves from failed to done", async () => {
    const run = start()
    run.row("b", { kind: "failed", message: "HTTP 500" })
    run.row("b", { kind: "done" })
    await vi.advanceTimersByTimeAsync(1_000)
    const [stored] = __storedTranscribeRuns()
    expect(stored!.doneIds).toEqual(["b"])
    expect(stored!.failed).toEqual([])
    run.end()
  })
})

describe("telling a running run from one a reload stopped (no Web Locks)", () => {
  it("is never interrupted for the page running it", async () => {
    const run = start()
    clock += STALE_MS * 10
    expect(await interruptedTranscribeRuns("p1")).toEqual([])
    run.end()
  })

  it("is still running for another page while its heartbeat is fresh", async () => {
    const run = start()
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    clock += HEARTBEAT_MS
    expect(await interruptedTranscribeRuns("p1")).toEqual([])
    __setTranscribeRunEnvForTests({ tab: "page-1" })
    run.end()
  })

  it("is interrupted once its page stopped stamping it, and can then be claimed once", async () => {
    start()
    // The page reloaded: its timers are gone with it.
    vi.clearAllTimers()
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    clock += STALE_MS
    const runs = await interruptedTranscribeRuns("p1")
    expect(runs.map((r) => r.id)).toEqual(["run-1"])
    const claiming = claimStoredTranscribeRun("run-1")
    await vi.advanceTimersByTimeAsync(100)
    const handle = await claiming
    expect(handle).not.toBeNull()
    // Claimed: it is this page's now, so nothing else picks it up.
    expect(await interruptedTranscribeRuns("p1")).toEqual([])
    handle!.end()
    expect(__storedTranscribeRuns()).toEqual([])
  })

  it("only lists the project's own runs, and forgets a week-old one", async () => {
    start("run-1")
    vi.clearAllTimers()
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    clock += STALE_MS
    expect(await interruptedTranscribeRuns("other-project")).toEqual([])
    clock += MAX_AGE_MS
    expect(await interruptedTranscribeRuns("p1")).toEqual([])
    expect(__storedTranscribeRuns()).toEqual([])
  })
})

describe("with Web Locks", () => {
  /** A lock manager that pretends another page holds `held`. */
  const fakeLocks = (held: string[]): LockManagerLike => ({
    request: async (name, options, callback) => {
      if (options.ifAvailable && held.includes(name)) return callback(null)
      return callback({ name })
    },
    query: async () => ({ held: held.map((name) => ({ name })) }),
  })

  it("a run whose lock another page holds is running there, however old its stamp", async () => {
    start()
    vi.clearAllTimers()
    __setTranscribeRunEnvForTests({ tab: "page-2", locks: fakeLocks(["aquilla-transcribe-run:run-1"]) })
    clock += STALE_MS * 10
    expect(await interruptedTranscribeRuns("p1")).toEqual([])
    expect(await claimStoredTranscribeRun("run-1")).toBeNull()
  })

  it("a run whose lock nobody holds was stopped, however fresh its stamp", async () => {
    start()
    vi.clearAllTimers()
    __setTranscribeRunEnvForTests({ tab: "page-2", locks: fakeLocks([]) })
    expect((await interruptedTranscribeRuns("p1")).map((r) => r.id)).toEqual(["run-1"])
    const handle = await claimStoredTranscribeRun("run-1")
    expect(handle).not.toBeNull()
    handle!.end()
  })
})
