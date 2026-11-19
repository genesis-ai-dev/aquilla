// Opening the Transcribe lens wakes the speech model its rows will run on and
// shows it waking until the server says it is ready; a model already up shows
// nothing. Which model that is comes from the Fast / Smart choice.

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
    const { result } = renderHook(() => useSpeechModelWarmup(session, "p1", "ctc"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(warmed).toEqual(["ctc"])
    expect(result.current.kind).toBe("starting")
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(result.current.kind).toBe("ready")
  })

  it("shows nothing, and warms nothing, when the model is already up or not needed", async () => {
    states.push("ready")
    const { result } = renderHook(() => useSpeechModelWarmup(session, "p1", "ctc"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.kind).toBe("hidden")
    const off = renderHook(() => useSpeechModelWarmup(session, "p1", null))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(off.result.current.kind).toBe("hidden")
    expect(warmed).toEqual([])
  })

  // The fast model is what the lens runs by default, and it wakes in seconds:
  // it is the one to start as the view opens, and it is asked about often
  // enough that "ready" is not reported seconds late.
  it("wakes the fast model as the view opens, and notices it ready within a couple of seconds", async () => {
    states.push("cold", "starting", "ready")
    const { result } = renderHook(() => useSpeechModelWarmup(session, "p1", "fast"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(warmed).toEqual(["fast"])
    expect(result.current).toEqual(expect.objectContaining({ kind: "starting", model: "fast" }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(result.current).toEqual({ kind: "ready", model: "fast" })
  })

  // Switching Fast → Smart must not leave the other model's "waking" on show.
  it("drops one model's status when the lens switches to another", async () => {
    states.push("cold", "starting", "starting", "starting")
    const { result, rerender } = renderHook(({ model }: { model: "fast" | "zs" }) => useSpeechModelWarmup(session, "p1", model), {
      initialProps: { model: "fast" },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.kind).toBe("starting")
    states.length = 0
    states.push("ready")
    rerender({ model: "zs" })
    expect(result.current.kind).toBe("hidden")
  })
})
