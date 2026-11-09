// AQU-2426 × AQU-2375: one line's words, a minute at a time, kept as they land.
// A reload or a failed minute never costs words already paid for, and the
// next run on the same stretch sends only the minutes still missing.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { LINE_WINDOW_SEC, planLineWindows, runLineWords, STOP_AFTER_FAILURES } from "./line-words-run"
import { lineWordsToast } from "./transcribe-report"
import {
  __setPageLeavingForTests,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  interruptedTranscribeRuns,
  claimStoredTranscribeRun,
} from "./transcribe-runs"
import type { LineAudio } from "./recording-split"

const RATE = 16_000
/** `sec` of speech, with a quiet half-second just before each minute mark. */
function pcm(sec: number): Float32Array {
  const out = new Float32Array(sec * RATE)
  for (let i = 0; i < out.length; i++) out[i] = 0.4 * Math.sin(i / 5)
  for (let m = 60; m < sec; m += 60) out.fill(0, (m - 1) * RATE, (m - 0.5) * RATE)
  return out
}

const audio: LineAudio = { projectId: "p1", fileId: "f1", url: "frontier-audio://p1/f1/a1.mp3", lo: 10_000, hi: 160_000 }
const identity = { cellId: "c1", audioId: "a1", name: "LOTE – Session 4.mp3" }

function wordsFor(line: { lo: number; hi: number }) {
  return { words: [{ text: `at${line.lo}`, start: 0.5, end: 1 }], text: `at${line.lo}.` }
}

beforeEach(() => {
  __setPageLeavingForTests(false)
  localStorage.clear()
  __setTranscribeRunEnvForTests({ tab: "page-1", now: () => 1_000_000, locks: null })
})

describe("planLineWindows", () => {
  it("cuts the stretch into windows of at most a minute, at a quiet moment, on the recording's clock", () => {
    const windows = planLineWindows(pcm(150), audio)
    expect(windows).toHaveLength(3)
    expect(windows[0]!.lo).toBe(audio.lo)
    expect(windows.at(-1)!.hi).toBe(audio.hi)
    for (const w of windows) expect(w.hi - w.lo).toBeLessThanOrEqual(LINE_WINDOW_SEC * 1000)
    // The cut moved back into the quiet stretch before the minute.
    expect(windows[1]!.lo).toBeGreaterThanOrEqual(audio.lo + 59_000)
    expect(windows[1]!.lo).toBeLessThan(audio.lo + 60_000)
    expect(windows[0]!.hi).toBe(windows[1]!.lo)
  })

  it("a line under a minute is one window: the whole stretch", () => {
    expect(planLineWindows(pcm(40), { lo: 0, hi: 40_000 })).toEqual([{ lo: 0, hi: 40_000 }])
  })
})

// AQU-2426 (review, Nov 9): a line whose length was never measured (lo = hi =
// 0) planned its last window to end at 0, which reads as "the whole clip": a
// 5-minute recording was sent as ten minutes and its text came back twice.
describe("a line with no measured length (AQU-2426 review)", () => {
  it("plans its windows over the recording as decoded, the last one ending where it ends", () => {
    const windows = planLineWindows(pcm(300), { lo: 0, hi: 0 })
    expect(windows.at(-1)!.hi).toBe(300_000)
    for (const w of windows) {
      expect(w.hi).toBeGreaterThan(w.lo)
      expect(w.hi - w.lo).toBeLessThanOrEqual(LINE_WINDOW_SEC * 1000)
    }
  })

  it("sends each minute once: five minutes of audio for a five-minute recording", async () => {
    const sent: Array<{ lo: number; hi: number }> = []
    const transcribe = vi.fn(async ({ line }: { line: LineAudio }) => {
      sent.push({ lo: line.lo, hi: line.hi })
      return wordsFor(line)
    })
    const { report } = await runLineWords({
      audio: { ...audio, lo: 0, hi: 0 }, session: null, purpose: "import", identity,
      deps: { transcribe, loadPcm: async () => pcm(300), newId: () => "words-1" },
    })
    expect(sent.every((w) => w.hi > w.lo)).toBe(true)
    expect(sent.reduce((ms, w) => ms + (w.hi - w.lo), 0)).toBe(300_000)
    expect(report.failed).toEqual([])
  })
})

describe("runLineWords", () => {
  it("transcribes each window once, puts its words on the line's clock, and keeps them", async () => {
    const transcribe = vi.fn(async ({ line }: { line: LineAudio }) => wordsFor(line))
    const progress: Array<[number, number]> = []
    const { report, handle } = await runLineWords({
      audio, session: null, purpose: "import", identity,
      onProgress: (d, t) => progress.push([d, t]),
      deps: { transcribe, loadPcm: async () => pcm(150), newId: () => "words-1" },
    })
    expect(transcribe).toHaveBeenCalledTimes(3)
    expect(report).toMatchObject({ total: 3, done: 3, failed: [], runId: "words-1" })
    expect(progress[0]).toEqual([0, 3])
    expect(progress.at(-1)).toEqual([3, 3])
    // Window 2's first word is 0.5 s into ITS stretch: from the line's start, later.
    const second = transcribe.mock.calls[1]![0].line
    expect(report.words[1]).toEqual({ text: `at${second.lo}`, start: 0.5 + (second.lo - audio.lo) / 1000, end: 1 + (second.lo - audio.lo) / 1000 })
    expect(report.text).toBe(`at${audio.lo}. at${second.lo}. at${transcribe.mock.calls[2]![0].line.lo}.`)
    handle!.park()
    expect(__storedTranscribeRuns()[0]!.line!.words.w2).toBeDefined()
  })

  it("some windows failed: says which, keeps the rest, and the next run sends only those", async () => {
    const transcribe = vi.fn(async ({ line }: { line: LineAudio }) => {
      if (line.lo > audio.lo && line.hi < audio.hi) throw new Error("HTTP 503")
      return wordsFor(line)
    })
    const first = await runLineWords({
      audio, session: null, purpose: "import", identity,
      deps: { transcribe, loadPcm: async () => pcm(150), newId: () => "words-1" },
    })
    expect(first.report).toMatchObject({ total: 3, done: 2, failed: [{ key: "w1", message: "HTTP 503" }] })
    first.handle!.park()

    // Retry: the kept run is taken over; nothing is decoded, only w1 is sent.
    transcribe.mockClear()
    transcribe.mockImplementation(async ({ line }: { line: LineAudio }) => wordsFor(line))
    const loadPcm = vi.fn(async () => pcm(150))
    const retry = await runLineWords({ audio, session: null, purpose: "import", identity, deps: { transcribe, loadPcm } })
    expect(loadPcm).not.toHaveBeenCalled()
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(retry.report).toMatchObject({ total: 3, done: 3, failed: [], runId: "words-1" })
    expect(retry.report.words).toHaveLength(3)
  })

  it(`stops after ${STOP_AFTER_FAILURES} windows fail in a row, and counts the rest as not done`, async () => {
    const transcribe = vi.fn(async () => { throw new Error("Your organization is out of AI credits.") })
    const { report } = await runLineWords({
      audio, session: null, purpose: "import", identity,
      deps: { transcribe, loadPcm: async () => pcm(150), newId: () => "words-1" },
    })
    expect(transcribe).toHaveBeenCalledTimes(STOP_AFTER_FAILURES)
    expect(report.done).toBe(0)
    expect(report.failed.map((f) => f.key)).toEqual(["w0", "w1", "w2"])
  })

  it("carries on a run a reload stopped from its own windows", async () => {
    const transcribe = vi.fn(async ({ line }: { line: LineAudio }) => wordsFor(line))
    // The first page got w0 in, then went away mid-run.
    const started = await runLineWords({
      audio, session: null, purpose: "import", identity,
      deps: {
        transcribe: vi.fn(async ({ line }: { line: LineAudio }) => {
          if (line.lo !== audio.lo) throw new Error("reload")
          return wordsFor(line)
        }),
        loadPcm: async () => pcm(150), newId: () => "words-1",
      },
    })
    expect(started.report.done).toBe(1)
    // (No park: the page is gone, so the record is just stale.)
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    const stored = __storedTranscribeRuns()[0]!
    const claiming = claimStoredTranscribeRun(stored.id)
    const handle = await claiming
    const progress: Array<[number, number]> = []
    const loadPcm = vi.fn(async () => pcm(150))
    const { report } = await runLineWords({
      audio, session: null, purpose: "import", carryOn: { stored, handle: handle! },
      onProgress: (d, t) => progress.push([d, t]),
      deps: { transcribe, loadPcm },
    })
    expect(loadPcm).not.toHaveBeenCalled()
    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(progress[0]).toEqual([1, 3])
    expect(report).toMatchObject({ total: 3, done: 3 })
  })

  it("without a line to keep it under, it runs but keeps nothing", async () => {
    const { report, handle } = await runLineWords({
      audio, session: null, purpose: "dialog",
      deps: { transcribe: async ({ line }) => wordsFor(line), loadPcm: async () => pcm(150) },
    })
    expect(report).toMatchObject({ done: 3, runId: null })
    expect(handle).toBeNull()
    expect(__storedTranscribeRuns()).toEqual([])
  })
})

describe("lineWordsToast", () => {
  const base = { words: [], text: "", runId: "words-1" }
  it("says nothing when every minute has words: the line is split", () => {
    expect(lineWordsToast({ ...base, total: 3, done: 3, failed: [] }, "Session 4.mp3")).toBeNull()
  })

  it("some minutes failed: how many landed, why, that it stays one line, and Retry for the rest", () => {
    const said = lineWordsToast({ ...base, total: 52, done: 40, failed: [{ key: "w40", message: "HTTP 503" }] }, "Session 4.mp3")!
    expect(said.type).toBe("error")
    expect(said.title).toBe("Transcribed 40 of 52 minutes of \"Session 4.mp3\".")
    expect(said.description).toContain("12 couldn't be transcribed. The first one said: HTTP 503")
    expect(said.description).toContain("It stays one line, with the words it has")
    expect(said.retryLabel).toBe("Retry the 12")
  })

  it("nothing landed: it couldn't be transcribed, and stays one line, with Retry", () => {
    const said = lineWordsToast({ ...base, total: 3, done: 0, failed: [{ key: "w0", message: "HTTP 503" }] }, "Session 4.mp3")!
    expect(said.title).toContain("Couldn't transcribe Session 4.mp3, so it stays one line.")
    expect(said.retryLabel).toBe("Retry the 3")
  })
})

describe("runLineWords when the page goes away", () => {
  it("a request cut off by a reload is not a failed minute: the run is left for the next page", async () => {
    let calls = 0
    const transcribe = vi.fn(async ({ line }: { line: LineAudio }) => {
      calls++
      if (calls === 2) {
        // The reload tears the page down mid-request.
        __setPageLeavingForTests(true)
        throw new TypeError("Load failed")
      }
      return wordsFor(line)
    })
    const { report, handle } = await runLineWords({
      audio, session: null, purpose: "import", identity,
      deps: { transcribe, loadPcm: async () => pcm(150), newId: () => "words-r" },
    })
    expect(report.interrupted).toBe(true)
    expect(report.failed).toEqual([])
    expect(report.done).toBe(1)
    // Nothing after the cut-off was sent.
    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(handle).not.toBeNull()
    // Another page sees it as stopped by a reload, not parked.
    __setTranscribeRunEnvForTests({ tab: "page-2", now: () => 1_000_000 + 60 * 60_000 })
    const stopped = await interruptedTranscribeRuns("p1")
    expect(stopped.map((r) => r.id)).toEqual(["words-r"])
    expect(stopped[0]!.parked).toBeFalsy()
  })
})

