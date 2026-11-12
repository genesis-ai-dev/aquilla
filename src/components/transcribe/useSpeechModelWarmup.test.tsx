// Opening the Transcribe lens starts a cold CTC model and shows it starting
// until the server says it is ready; a model already up shows nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"

const states: string[] = []
const warmed: string[] = []
vi.mock("@/lib/audio/omni-warmup", () => ({
  WARMUP_POLL_MS: 4000,
  WARMUP_CAP_MS: 60_000,
  fetchOmniStatus: vi.fn(async () => ({ state: states.shift() ?? "ready" })),
  warmOmni: vi.fn(async (_jwt: string, _projectId: string, model: string) => { warmed.push(model) }),
}))
vi.mock("@/lib/audio/transcription-preference", () => ({ usesHostedTranscription: () => true }))

import { useSpeechModelWarmup } from "./useSpeechModelWarmup"

const session = { jwt: "j", username: "u" } as never

beforeEach(() => {
  vi.useFakeTimers()
  states.length = 0
  warmed.length = 0
})
afterEach(() => vi.useRealTimers())

describe("useSpeechModelWarmup", () => {
  it("warms a cold CTC model and reports it starting, then ready", async () => {
    states.push("cold", "starting", "ready")
    const { result } = renderHook(() => useSpeechModelWarmup(session, "p1", true))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(warmed).toEqual(["ctc"])
    expect(result.current.kind).toBe("starting")
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(result.current.kind).toBe("ready")
  })

  it("shows nothing, and warms nothing, when the model is already up or not needed", async () => {
    states.push("ready")
    const { result } = renderHook(() => useSpeechModelWarmup(session, "p1", true))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.kind).toBe("hidden")
    const off = renderHook(() => useSpeechModelWarmup(session, "p1", false))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(off.result.current.kind).toBe("hidden")
    expect(warmed).toEqual([])
  })
})
