// AQU-2375: a transcription run's record outlives the page, and only a page
// that is gone leaves a run to be carried on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  HEARTBEAT_MS,
  MAX_AGE_MS,
  STALE_MS,
  __setPageLeavingForTests,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  claimStoredTranscribeRun,
  findLineWordsRun,
  interruptedTranscribeRuns,
  startStoredTranscribeRun,
  transcribeRunFits,
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

// AQU-2426 × AQU-2375: one line's words are a kept run too, window by window.
describe("a line's words run", () => {
  const startLine = (id = "words-1") => startStoredTranscribeRun({
    id,
    projectId: "p1",
    fileId: "f1",
    fileName: "LOTE – Session 4.mp3",
    kind: "lineWords",
    cellIds: ["w0", "w1", "w2"],
    force: false,
    line: {
      cellId: "c1", audioId: "a1", url: "frontier-audio://p1/f1/a1.mp3", lo: 0, hi: 150_000,
      windows: [{ lo: 0, hi: 60_000 }, { lo: 60_000, hi: 120_000 }, { lo: 120_000, hi: 150_000 }],
      words: {},
      purpose: "import",
    },
  })
  const match = { projectId: "p1", fileId: "f1", cellId: "c1", audioId: "a1", lo: 0, hi: 150_000 }

  it("keeps each window's words as they land", async () => {
    const run = startLine()
    run.row("w0", { kind: "done", lineWords: { words: [{ text: "In", start: 0.2, end: 0.4 }], text: "In" } })
    await vi.advanceTimersByTimeAsync(1_000)
    const [stored] = __storedTranscribeRuns()
    expect(stored!.doneIds).toEqual(["w0"])
    expect(stored!.line!.words).toEqual({ w0: { words: [{ text: "In", start: 0.2, end: 0.4 }], text: "In" } })
  })

  it("parked, it keeps what it has at once, and is never carried on by itself", async () => {
    const run = startLine()
    run.row("w0", { kind: "done", lineWords: { words: [], text: "In the beginning" } })
    run.row("w1", { kind: "failed", message: "HTTP 503" })
    run.park()
    // Written without waiting for the throttle: the page may be about to go.
    const [stored] = __storedTranscribeRuns()
    expect(stored!.parked).toBe(true)
    expect(stored!.line!.words.w0!.text).toBe("In the beginning")
    expect(stored!.failed).toEqual([{ cellId: "w1", message: "HTTP 503" }])
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    clock += STALE_MS * 2
    expect(await interruptedTranscribeRuns("p1")).toEqual([])
  })

  it("is found by its line and stretch, and taken over runs again", async () => {
    const run = startLine()
    run.park()
    expect(findLineWordsRun(match)?.id).toBe("words-1")
    expect(findLineWordsRun({ ...match, hi: 140_000 })).toBeNull()
    expect(findLineWordsRun({ ...match, cellId: "c2" })).toBeNull()
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    const claiming = claimStoredTranscribeRun("words-1")
    await vi.advanceTimersByTimeAsync(100)
    expect(await claiming).not.toBeNull()
    const [stored] = __storedTranscribeRuns()
    expect(stored!.parked).toBeUndefined()
    expect(stored!.tab).toBe("page-2")
  })

  it("stopped by a reload (not parked), it is carried on like any run", async () => {
    startLine()
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    clock += STALE_MS
    expect((await interruptedTranscribeRuns("p1")).map((r) => r.id)).toEqual(["words-1"])
  })

  it("a week-old kept run is not found", () => {
    startLine().park()
    clock += MAX_AGE_MS
    expect(findLineWordsRun(match)).toBeNull()
  })
})

// AQU-2426 (review, Nov 9): a line's words now stay kept after the split that
// used them (so Undo doesn't cost them), which makes old parked runs the
// thing to give up when the browser's storage is full.
describe("when storage is full", () => {
  it("gives up the oldest parked words so a new run is still kept", () => {
    const parked = (id: string) => {
      const run = startStoredTranscribeRun({
        id, projectId: "p1", fileId: "f1", fileName: "Session 4.mp3", kind: "lineWords", cellIds: ["w0"], force: false,
        line: { cellId: id, audioId: "a1", url: "frontier-audio://p1/f1/a1.mp3", lo: 0, hi: 60_000, windows: [{ lo: 0, hi: 60_000 }], words: {}, purpose: "import" },
      })
      run.row("w0", { kind: "done", lineWords: { words: [], text: "x".repeat(400) } })
      run.park()
    }
    parked("old")
    clock += 60_000
    parked("newer")
    clock += 60_000
    // Room for what is there now, and not for one run more.
    const room = JSON.stringify(__storedTranscribeRuns()).length + 50
    const real = localStorage.setItem.bind(localStorage)
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (value.length > room) throw new DOMException("full", "QuotaExceededError")
      real(key, value)
    })
    try {
      const run = start("run-now")
      expect(__storedTranscribeRuns().map((r) => r.id).sort()).toEqual(["newer", "run-now"])
      run.end()
    } finally {
      setItem.mockRestore()
    }
  })
})

// AQU-2375 (review, Nov 9)
describe("transcribeRunFits: whose run it is, and which language's", () => {
  it("only the person who started a run carries it on", () => {
    expect(transcribeRunFits({ kind: "all", username: "amina", lane: "" }, { username: "amina", lane: "" })).toBe("ok")
    expect(transcribeRunFits({ kind: "all", username: "amina", lane: "" }, { username: "baraka", lane: "" })).toBe("person")
    expect(transcribeRunFits({ kind: "lineWords", username: "amina" }, { username: null, lane: "" })).toBe("person")
  })

  it("a run over takes waits for the language it was started in; one over the source recording does not", () => {
    expect(transcribeRunFits({ kind: "all", username: "amina", lane: "fr" }, { username: "amina", lane: "" })).toBe("lane")
    expect(transcribeRunFits({ kind: "sections", username: "amina", lane: "" }, { username: "amina", lane: "fr" })).toBe("lane")
    expect(transcribeRunFits({ kind: "lineWords", username: "amina", lane: "fr" }, { username: "amina", lane: "" })).toBe("ok")
    expect(transcribeRunFits({ kind: "import", username: "amina", lane: "fr" }, { username: "amina", lane: "" })).toBe("ok")
  })

  it("a run kept before runs named their person and language is carried on as before", () => {
    expect(transcribeRunFits({ kind: "all" }, { username: "baraka", lane: "fr" })).toBe("ok")
  })
})

// AQU-2375 (review, Nov 9): rows are written at most once a second, so the
// ones that landed just before a reload were missing from the record, and the
// run carried on reported "880 of 900" with all 900 transcribed.
describe("when the page goes away", () => {
  it("writes the rows that landed in the last second at once", () => {
    const run = start()
    run.row("a", { kind: "done" })
    expect(__storedTranscribeRuns()[0]!.doneIds).toEqual([])
    try {
      window.dispatchEvent(new Event("pagehide"))
      expect(__storedTranscribeRuns()[0]!.doneIds).toEqual(["a"])
    } finally {
      __setPageLeavingForTests(false)
      run.end()
    }
  })
})
