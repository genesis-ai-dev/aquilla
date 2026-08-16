// Meeting 2026-08-05: the device playback-quality pref. resolveAudioSrc may
// swap a GENERATED voice's compressed primary for its lossless WAV sibling —
// decided before the stream URL is minted, silently falling back when the
// sibling is absent, and never probing for ineligible attachments.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

const probeCellAudioPresent = vi.fn()
vi.mock("./upload", async () => {
  const actual = await vi.importActual<typeof import("./upload")>("./upload")
  return {
    ...actual,
    probeCellAudioPresent: (...args: unknown[]) => probeCellAudioPresent(...args),
    // Ext-distinguishable stream URLs — the element's src is the assertion.
    getCellAudioStreamUrl: async (a: { audioId: string; ext: string }) =>
      `https://stream.test/${a.audioId}.${a.ext}?t=tok`,
  }
})
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => null,
  audioCachePut: async () => undefined,
}))
vi.mock("./sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

import { setQueueTimingMode, startQueue, stopQueue } from "./play-queue"
import { buildFrontierAudioUrl } from "./upload"
import {
  resetAudioQualityPrefCacheForTests,
  setAudioQualityPref,
} from "@/lib/store/audio-quality-pref"
import { resetLosslessSiblingMemoForTests } from "./lossless-sibling"

class FakeAudio {
  static created: FakeAudio[] = []
  src: string
  paused = true
  currentTime = 0
  duration = NaN
  readyState = 4
  preload = ""
  muted = false
  volume = 1
  playbackRate = 1
  constructor(src = "") {
    this.src = src
    FakeAudio.created.push(this)
  }
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const session = { jwt: "jwt", username: "u" } as unknown as FrontierSession

/** A cell whose ONLY audio is a client-synth generated voice (webm primary). */
function generatedCell(id: string): CellData {
  const base = `audio-${id}-1700000001-gen`
  return {
    id, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    selectedGeneratedVoiceAudioId: `${base}.webm`,
    attachments: { [`${base}.webm`]: { url: buildFrontierAudioUrl(base, "webm"), type: "audio" } },
  } as unknown as CellData
}

/** A mic-take cell — webm too, but never eligible for the WAV swap. */
function takeCell(id: string): CellData {
  const base = `audio-${id}-1700000000-take`
  return {
    id, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    selectedAudioId: `${base}.webm`,
    attachments: { [`${base}.webm`]: { url: buildFrontierAudioUrl(base, "webm"), type: "audio" } },
  } as unknown as CellData
}

const startedSrc = () => FakeAudio.created.map((a) => a.src).filter(Boolean)

describe("play-queue quality preference", () => {
  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudio)
    FakeAudio.created = []
    probeCellAudioPresent.mockReset()
    localStorage.removeItem("aq.audio-quality.v1")
    resetAudioQualityPrefCacheForTests()
    resetLosslessSiblingMemoForTests()
    setQueueTimingMode("dubbing")
  })
  afterEach(() => {
    stopQueue()
    vi.unstubAllGlobals()
  })

  it("default (compressed): plays the .webm primary and never probes", async () => {
    startQueue({ cells: [generatedCell("c1")], projectId: "p1", session }, 0)
    await vi.waitFor(() => expect(startedSrc().some((s) => s.includes(".webm"))).toBe(true))
    expect(probeCellAudioPresent).not.toHaveBeenCalled()
  })

  it("original + sibling present: plays the .wav sibling", async () => {
    setAudioQualityPref("original")
    probeCellAudioPresent.mockResolvedValue("present")
    startQueue({ cells: [generatedCell("c1")], projectId: "p1", session }, 0)
    await vi.waitFor(() => expect(startedSrc().some((s) => s.includes(".wav"))).toBe(true))
    expect(startedSrc().some((s) => s.includes(".webm"))).toBe(false)
    expect(probeCellAudioPresent).toHaveBeenCalledWith(expect.objectContaining({ ext: "wav" }))
  })

  it("original + sibling missing: silently falls back to the .webm primary", async () => {
    setAudioQualityPref("original")
    probeCellAudioPresent.mockResolvedValue("missing")
    startQueue({ cells: [generatedCell("c1")], projectId: "p1", session }, 0)
    await vi.waitFor(() => expect(startedSrc().some((s) => s.includes(".webm"))).toBe(true))
    expect(startedSrc().some((s) => s.includes(".wav"))).toBe(false)
  })

  it("original + a MIC take: never probes, plays the take as-is", async () => {
    setAudioQualityPref("original")
    startQueue({ cells: [takeCell("c1")], projectId: "p1", session }, 0)
    await vi.waitFor(() => expect(startedSrc().some((s) => s.includes(".webm"))).toBe(true))
    expect(probeCellAudioPresent).not.toHaveBeenCalled()
  })
})
