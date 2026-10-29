// AQU-1642 follow-up (Sam, 2026-10-17): the Audio view's place, carried out on
// the play queue. The rules themselves are tested in audio-view-place.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"

const queue = vi.hoisted(() => ({
  state: { kind: "idle" } as { kind: string; cellId?: string },
  startQueueAtCell: vi.fn(),
  stopQueue: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(async () => {}),
  seekQueueInCell: vi.fn(() => true),
}))
vi.mock("@/lib/audio/play-queue", () => ({
  getQueueState: () => queue.state,
  startQueueAtCell: queue.startQueueAtCell,
  stopQueue: queue.stopQueue,
  pauseQueue: queue.pauseQueue,
  resumeQueue: queue.resumeQueue,
  seekQueueInCell: queue.seekQueueInCell,
}))

import { useAudioViewPlace } from "./useAudioViewPlace"

const cells = ["v1", "v2", "v3"].map((id) => ({ id, fileId: "f1" }) as CellData)
const session = { jwt: "t" } as never

function mount(fileId = "f1") {
  const hook = renderHook(({ fileId }) => useAudioViewPlace(fileId), { initialProps: { fileId } })
  hook.result.current.contextRef.current = { cells, projectId: "p1", session, onActiveCell: vi.fn() }
  return hook
}

beforeEach(() => {
  queue.state = { kind: "idle" }
  for (const fn of [queue.startQueueAtCell, queue.stopQueue, queue.pauseQueue, queue.resumeQueue, queue.seekQueueInCell]) fn.mockClear()
})

describe("useAudioViewPlace", () => {
  it("selecting a verse while the run waits elsewhere ends the run, and Play starts from that verse", () => {
    queue.state = { kind: "paused", cellId: "v1" }
    const { result } = mount()
    act(() => result.current.place.select("v3"))
    expect(queue.stopQueue).toHaveBeenCalledTimes(1)
    expect(result.current.place.startCellId).toBe("v3")
  })

  it("selecting a verse while the run plays leaves it playing", () => {
    queue.state = { kind: "playing", cellId: "v1" }
    const { result } = mount()
    act(() => result.current.place.select("v3"))
    expect(queue.stopQueue).not.toHaveBeenCalled()
    expect(result.current.place.startCellId).toBe("v3")
  })

  it("a card's Play opens the run at its verse, and plays on", () => {
    const { result } = mount()
    act(() => result.current.place.pressCard("v2"))
    expect(queue.startQueueAtCell).toHaveBeenCalledWith(
      expect.objectContaining({ cells, projectId: "p1", session }),
      1,
      { play: true },
    )
  })

  it("a card's Stop ends the run and keeps its verse as where Play starts", () => {
    queue.state = { kind: "playing", cellId: "v2" }
    const { result } = mount()
    act(() => result.current.place.pressCard("v2"))
    expect(queue.stopQueue).toHaveBeenCalledTimes(1)
    expect(result.current.place.startCellId).toBe("v2")
  })

  it("⋯ Play audio pauses the run on its verse, and resumes it", () => {
    queue.state = { kind: "playing", cellId: "v2" }
    const { result } = mount()
    act(() => result.current.place.pressMenu("v2"))
    expect(queue.pauseQueue).toHaveBeenCalledTimes(1)
    queue.state = { kind: "paused", cellId: "v2" }
    act(() => result.current.place.pressMenu("v2"))
    expect(queue.resumeQueue).toHaveBeenCalledTimes(1)
  })

  it("a click on another verse's waveform opens the run there, waiting unless it was playing", () => {
    queue.state = { kind: "paused", cellId: "v1" }
    const { result } = mount()
    act(() => result.current.place.pickOnWaveform("v3", 1.5))
    expect(queue.startQueueAtCell).toHaveBeenCalledWith(expect.anything(), 2, { atSeconds: 1.5, play: false })
  })

  it("a click on the waveform of the verse the run is on moves within it", () => {
    queue.state = { kind: "playing", cellId: "v2" }
    const { result } = mount()
    act(() => result.current.place.pickOnWaveform("v2", 0.75))
    expect(queue.seekQueueInCell).toHaveBeenCalledWith("v2", 0.75)
    expect(queue.startQueueAtCell).not.toHaveBeenCalled()
  })

  it("a run in another file is not this file's place", () => {
    queue.state = { kind: "paused", cellId: "elsewhere" }
    const { result } = mount()
    act(() => result.current.place.select("v1"))
    expect(queue.stopQueue).not.toHaveBeenCalled()
  })

  it("forgets the verse to start from when the file changes", () => {
    const hook = mount()
    act(() => hook.result.current.place.select("v2"))
    expect(hook.result.current.place.startCellId).toBe("v2")
    hook.rerender({ fileId: "f2" })
    expect(hook.result.current.place.startCellId).toBeNull()
  })
})
