// Sam, 2026-10-19: leaving the Aquilla tab pauses whatever is playing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

const players = vi.hoisted(() => ({
  queueKind: "idle" as string,
  pauseQueue: vi.fn(),
  video: null as null | { isPaused: () => boolean; pause: () => void },
  active: null as null | { isPlaying: () => boolean; pause: () => void },
}))
vi.mock("@/lib/audio/play-queue", () => ({
  getQueueState: () => ({ kind: players.queueKind }),
  pauseQueue: players.pauseQueue,
}))
vi.mock("@/lib/timeline/video-controller", () => ({ getVideoController: () => players.video }))
vi.mock("@/lib/audio/audio-coordinator", () => ({ getActiveAudio: () => players.active }))

import { usePauseAudioWhenHidden } from "./usePauseAudioWhenHidden"

let visibility: DocumentVisibilityState = "visible"
const leaveTab = () => {
  visibility = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
}
const comeBack = () => {
  visibility = "visible"
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  players.queueKind = "idle"
  players.pauseQueue.mockClear()
  players.video = null
  players.active = null
})
afterEach(() => vi.restoreAllMocks())

describe("usePauseAudioWhenHidden", () => {
  it("pauses the timeline's clock when the tab is left, and leaves it paused on return", () => {
    let paused = false
    const pause = vi.fn(() => { paused = true })
    players.video = { isPaused: () => paused, pause }
    renderHook(() => usePauseAudioWhenHidden())
    leaveTab()
    expect(pause).toHaveBeenCalledTimes(1)
    comeBack()
    expect(pause).toHaveBeenCalledTimes(1)
    expect(paused).toBe(true)
  })

  it("pauses the bottom bar's run and a card's own player", () => {
    players.queueKind = "playing"
    const pause = vi.fn()
    players.active = { isPlaying: () => true, pause }
    renderHook(() => usePauseAudioWhenHidden())
    leaveTab()
    expect(players.pauseQueue).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it("touches nothing that is not playing", () => {
    const videoPause = vi.fn()
    const activePause = vi.fn()
    players.queueKind = "paused"
    players.video = { isPaused: () => true, pause: videoPause }
    players.active = { isPlaying: () => false, pause: activePause }
    renderHook(() => usePauseAudioWhenHidden())
    leaveTab()
    expect(players.pauseQueue).not.toHaveBeenCalled()
    expect(videoPause).not.toHaveBeenCalled()
    expect(activePause).not.toHaveBeenCalled()
  })

  it("stops listening once the workspace closes", () => {
    const pause = vi.fn()
    players.active = { isPlaying: () => true, pause }
    const { unmount } = renderHook(() => usePauseAudioWhenHidden())
    unmount()
    leaveTab()
    expect(pause).not.toHaveBeenCalled()
  })
})
