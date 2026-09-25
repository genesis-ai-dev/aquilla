import { describe, expect, it, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { __setQueuePlaybackForTests, useQueueCellPlayhead } from "./play-queue"

afterEach(() => {
  __setQueuePlaybackForTests({ cellId: null, currentTime: 0, playing: false })
})

describe("useQueueCellPlayhead", () => {
  it("reports Play All's clock only for the cell that is sounding", () => {
    __setQueuePlaybackForTests({ cellId: "line-2", currentTime: 0.4, playing: true })
    const playing = renderHook(() => useQueueCellPlayhead("line-2"))
    const other = renderHook(() => useQueueCellPlayhead("line-1"))
    expect(playing.result.current).toBe(0.4)
    expect(other.result.current).toBeNull()

    __setQueuePlaybackForTests({ cellId: "line-2", currentTime: 1.1, playing: true })
    playing.rerender()
    expect(playing.result.current).toBe(1.1)
  })

  it("drops the clock when Play All pauses", () => {
    __setQueuePlaybackForTests({ cellId: "line-2", currentTime: 0.4, playing: true })
    const { result, rerender } = renderHook(() => useQueueCellPlayhead("line-2"))
    __setQueuePlaybackForTests({ cellId: "line-2", currentTime: 0.4, playing: false })
    rerender()
    expect(result.current).toBeNull()
  })
})
