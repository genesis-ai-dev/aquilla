// AQU-2426 (review, Nov 9): a take recorded over the hourly limit waits and
// transcribes by itself — and now does so across a reload too. The wait was
// in memory only, so a reload during it (up to 15 minutes) left the take
// "Not transcribed" for good.

import { beforeEach, describe, expect, it } from "vitest"
import {
  __setPageLeavingForTests,
  __setTranscribeRunEnvForTests,
  __storedTranscribeRuns,
  interruptedTranscribeRuns,
  STALE_MS,
} from "./transcribe-runs"
import { getTranscribeStatus } from "./transcribe-status"
import { waitingTake } from "./waiting-take"

let clock = 1_000_000
const keep = {
  projectId: "p1", fileId: "f1", fileName: "Ruth 1", cellId: "c7", username: "amina", lane: "fr", targetLanguage: "French",
}

beforeEach(() => {
  __setPageLeavingForTests(false)
  localStorage.clear()
  clock = 1_000_000
  __setTranscribeRunEnvForTests({ tab: "page-1", now: () => clock, locks: null })
})

describe("waitingTake", () => {
  it("a take that never met the limit keeps nothing", () => {
    const take = waitingTake({ audioId: "c7-take.webm", keep })
    take.settled()
    expect(__storedTranscribeRuns()).toEqual([])
  })

  it("keeps the take as a one-row run while it waits, and forgets it once it is transcribed", async () => {
    let release: () => void = () => {}
    const take = waitingTake({ audioId: "c7-take.webm", keep, sleep: () => new Promise<void>((r) => { release = r }) })
    const waiting = take.onRateLimited(600)
    expect(getTranscribeStatus("c7-take.webm")).toEqual({ kind: "transcribing", waiting: "limit" })
    expect(__storedTranscribeRuns()).toMatchObject([{
      projectId: "p1", fileId: "f1", fileName: "Ruth 1", kind: "sections", cellIds: ["c7"], force: false,
      username: "amina", lane: "fr", targetLang: "fr", targetLanguage: "French",
    }])
    release()
    await waiting
    // Refused again: still one kept run, not two.
    void take.onRateLimited(60)
    expect(__storedTranscribeRuns()).toHaveLength(1)
    take.settled()
    expect(__storedTranscribeRuns()).toEqual([])
  })

  it("a reload during the wait leaves it kept, for the next page to carry on", async () => {
    const take = waitingTake({ audioId: "c7-take.webm", keep, sleep: () => new Promise<void>(() => {}) })
    void take.onRateLimited(600)
    // The page goes; whatever was in flight ends.
    __setPageLeavingForTests(true)
    take.settled()
    expect(__storedTranscribeRuns()).toHaveLength(1)
    // The next page finds it as a run a reload stopped.
    __setPageLeavingForTests(false)
    clock += STALE_MS
    __setTranscribeRunEnvForTests({ tab: "page-2" })
    expect((await interruptedTranscribeRuns("p1")).map((r) => r.cellIds)).toEqual([["c7"]])
  })

  it("a take with nowhere to be kept still waits", async () => {
    const take = waitingTake({ audioId: "c7-take.webm", keep: null, sleep: async () => {} })
    await take.onRateLimited(1)
    expect(__storedTranscribeRuns()).toEqual([])
    expect(getTranscribeStatus("c7-take.webm")).toEqual({ kind: "transcribing" })
  })
})
