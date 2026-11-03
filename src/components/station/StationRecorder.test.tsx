// AQU-2327 slice 14: Record now records in the Station — count in, record at
// the cursor, put it in on Stop, then Keep or Record again.
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecorderState } from "@/hooks/useAudioRecorder"
import type { StationEditor } from "./useStationEditor"

const rec = vi.hoisted(() => ({
  state: { kind: "idle" } as RecorderState,
  prewarm: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  reset: vi.fn(),
  releaseMic: vi.fn(),
}))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({ ...rec, elapsedMs: 0, isNearLimit: false, stream: null }),
}))
vi.mock("@/components/AudioRecorder/probeMicPermission", () => ({ probeMicPermission: async () => "granted" }))
vi.mock("@/lib/store/recording-countdown-pref", () => ({
  countdownStepMs: () => null,
  useRecordingCountdownBeep: () => false,
  useRecordingCountdownSpeed: () => "off",
}))
vi.mock("@/lib/audio/decode-mono", () => ({ TARGET_RATE: 48000, decodeToMono48k: async () => new Float32Array(48000 * 2) }))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: async () => {} }))

const { useStationRecorder } = await import("./StationRecorder")

/** Like the real editor, an insert adds an edit and Undo takes the newest out. */
function fakeEditor(ops = 0) {
  const list: unknown[] = Array.from({ length: ops })
  return {
    ops: list,
    pcm: { duration: 4 },
    pause: vi.fn(),
    select: vi.fn(),
    setLive: vi.fn(),
    insertAudio: vi.fn(() => void list.push({})),
    undoUnsaved: vi.fn(() => list.pop() !== undefined),
  } as unknown as StationEditor & { insertAudio: ReturnType<typeof vi.fn>; undoUnsaved: ReturnType<typeof vi.fn> }
}

afterEach(() => {
  rec.state = { kind: "idle" }
  vi.clearAllMocks()
})

describe("Record now in the Station", () => {
  it("records at the cursor, puts the recording in on Stop, and waits for Keep", async () => {
    const ed = fakeEditor()
    const onMessage = vi.fn()
    const { result, rerender } = renderHook(({ e }) => useStationRecorder(e, onMessage), { initialProps: { e: ed } })

    act(() => result.current.start(1.5))
    expect(result.current.phase).toEqual({ kind: "counting", at: 1.5 })
    expect(ed.select).toHaveBeenCalledWith(1.5, 1.5)
    await waitFor(() => expect(rec.start).toHaveBeenCalled())
    expect(rec.prewarm).toHaveBeenCalled()

    rec.state = { kind: "recording", startedAt: 0 }
    rerender({ e: ed })
    expect(result.current.phase.kind).toBe("recording")

    act(() => result.current.stop())
    expect(rec.stop).toHaveBeenCalled()
    expect(result.current.phase.kind).toBe("finishing")

    rec.state = { kind: "stopped", blob: new Blob(["x"]), mimeType: "audio/wav", ext: "wav", durationSec: 2 }
    rerender({ e: ed })
    await waitFor(() => expect(result.current.phase.kind).toBe("pending"))
    expect(ed.insertAudio).toHaveBeenCalledTimes(1)
    expect(ed.insertAudio.mock.calls[0][2]).toMatchObject({ kind: "recording", ext: "wav", label: "a recording made here" })
    expect(result.current.phase).toMatchObject({ kind: "pending", at: 1.5, len: 2, ops: 1 })
    expect(onMessage).not.toHaveBeenCalled()

    // Keep leaves the insert in.
    act(() => result.current.keep())
    expect(result.current.phase.kind).toBe("idle")
    expect(ed.undoUnsaved).not.toHaveBeenCalled()
    expect(ed.ops).toHaveLength(1)
    expect(rec.releaseMic).toHaveBeenCalled()
  })

  it("Record again takes the recording back out and counts in at the same place", async () => {
    const ed = fakeEditor()
    const { result, rerender } = renderHook(({ e }) => useStationRecorder(e, vi.fn()), { initialProps: { e: ed } })
    act(() => result.current.start(0.8))
    await waitFor(() => expect(rec.start).toHaveBeenCalled())
    rec.state = { kind: "recording", startedAt: 0 }
    rerender({ e: ed })
    act(() => result.current.stop())
    rec.state = { kind: "stopped", blob: new Blob(["y"]), mimeType: "audio/wav", ext: "wav", durationSec: 2 }
    rerender({ e: ed })
    await waitFor(() => expect(result.current.phase.kind).toBe("pending"))

    rec.state = { kind: "idle" }
    act(() => result.current.again())
    expect(ed.undoUnsaved).toHaveBeenCalledTimes(1)
    expect(ed.ops).toHaveLength(0)
    expect(ed.select).toHaveBeenLastCalledWith(0.8, 0.8)
    expect(result.current.phase).toEqual({ kind: "counting", at: 0.8 })
  })

  it("another edit while it waits counts as keeping it", async () => {
    const ed = fakeEditor()
    const { result, rerender } = renderHook(({ e }) => useStationRecorder(e, vi.fn()), { initialProps: { e: ed } })
    act(() => result.current.start(0))
    await waitFor(() => expect(rec.start).toHaveBeenCalled())
    rec.state = { kind: "recording", startedAt: 0 }
    rerender({ e: ed })
    act(() => result.current.stop())
    rec.state = { kind: "stopped", blob: new Blob(["z"]), mimeType: "audio/wav", ext: "wav", durationSec: 2 }
    rerender({ e: ed })
    await waitFor(() => expect(result.current.phase.kind).toBe("pending"))
    rerender({ e: fakeEditor(2) })
    expect(result.current.phase.kind).toBe("idle")
  })
})
