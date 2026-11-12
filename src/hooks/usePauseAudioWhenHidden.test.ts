// Sam, 2026-10-19/20: leaving the Aquilla tab pauses whatever is playing, and
// coming back plays it on — only what leaving paused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

const players = vi.hoisted(() => ({
  queueKind: "idle" as string,
  pauseQueue: vi.fn(() => { players.queueKind = "paused" }),
  resumeQueue: vi.fn(async () => { players.queueKind = "playing" }),
  video: null as null | { isPaused: () => boolean; pause: () => void; play?: () => void },
  active: null as null | { isPlaying: () => boolean; pause: () => void; play?: () => Promise<void> },
}))
vi.mock("@/lib/audio/play-queue", () => ({
  getQueueState: () => ({ kind: players.queueKind }),
  pauseQueue: players.pauseQueue,
  resumeQueue: players.resumeQueue,
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
  players.resumeQueue.mockClear()
  players.video = null
  players.active = null
})
afterEach(() => vi.restoreAllMocks())

describe("usePauseAudioWhenHidden", () => {
  it("pauses the timeline's clock when the tab is left, and plays it on when you come back", () => {
    let paused = false
    const pause = vi.fn(() => { paused = true })
    const play = vi.fn(() => { paused = false })
    players.video = { isPaused: () => paused, pause, play }
    renderHook(() => usePauseAudioWhenHidden())
    leaveTab()
    expect(pause).toHaveBeenCalledTimes(1)
    expect(paused).toBe(true)
    comeBack()
    expect(play).toHaveBeenCalledTimes(1)
    expect(paused).toBe(false)
    // A second return with nothing paused by leaving plays nothing.
    comeBack()
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("never plays on what was already paused when the tab was left", () => {
    const play = vi.fn()
    players.video = { isPaused: () => true, pause: vi.fn(), play }
    players.queueKind = "paused"
    renderHook(() => usePauseAudioWhenHidden())
    leaveTab()
    comeBack()
    expect(play).not.toHaveBeenCalled()
    expect(players.resumeQueue).not.toHaveBeenCalled()
  })

  it("pauses the bottom bar's run and a card's own player", () => {
    players.queueKind = "playing"
    const pause = vi.fn()
    players.active = { isPlaying: () => true, pause }
    renderHook(() => usePauseAudioWhenHidden())
    leaveTab()
    expect(players.pauseQueue).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalledTimes(1)
    comeBack()
    expect(players.resumeQueue).toHaveBeenCalledTimes(1)
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
