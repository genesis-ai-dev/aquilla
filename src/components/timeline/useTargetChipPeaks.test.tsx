// The open of a dubbed file used to decode every take in the mounted columns
// in the same turn the lanes appeared. That is a main-thread hitch per clip.
// The load waits until the browser is idle.

import { describe, it, expect, vi, afterEach } from "vitest"
import { render } from "@testing-library/react"
import { useTargetChipPeaks } from "./useTargetChipPeaks"
import type { PeaksTarget } from "@/lib/audio/peaks-loader"
import type { FrontierSession } from "@/lib/frontier/types"

const loadPeaksBatch = vi.fn()
vi.mock("@/lib/audio/peaks-loader", () => ({
  loadPeaksBatch: (...args: unknown[]) => loadPeaksBatch(...args),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

const target: PeaksTarget = {
  attachmentKey: "audio-c1-1-aaaaaaaa.wav",
  url: "frontier-audio://audio-c1-1-aaaaaaaa.wav",
  fileId: "f1",
}
const session = { jwt: "j", username: "dev" } as FrontierSession

function Probe() {
  useTargetChipPeaks({
    targets: [target],
    projectId: "p1",
    fileId: "f1",
    session,
    bins: 320,
  })
  return null
}

afterEach(() => {
  loadPeaksBatch.mockReset()
  vi.unstubAllGlobals()
})

describe("useTargetChipPeaks", () => {
  it("does not start decoding in the turn the chips mount", () => {
    const queued: IdleRequestCallback[] = []
    vi.stubGlobal("requestIdleCallback", (cb: IdleRequestCallback) => {
      queued.push(cb)
      return 1
    })
    vi.stubGlobal("cancelIdleCallback", () => {})

    render(<Probe />)
    expect(loadPeaksBatch).not.toHaveBeenCalled()

    queued.at(-1)?.({ didTimeout: false, timeRemaining: () => 10 })
    expect(loadPeaksBatch).toHaveBeenCalledOnce()
    expect(loadPeaksBatch.mock.calls[0]?.[0]).toMatchObject({ concurrency: 1, pauseMs: 32 })
  })
})
