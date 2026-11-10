/**
 * AQU-2253 (review, Nov 9, finding 5): a seek that never lands, and the
 * watchdog's last rung in a browser that cannot play a stream by itself.
 *
 * fce231606 judged any seek over loaded film as a stall at once: a slow but
 * healthy seek, or a scrub, got the stall treatment after one or two seconds,
 * and the first rung sent a second seek while the first was still in flight
 * (what `video-seek-coalesce` exists to prevent: hls.js stops producing frames
 * after a burst of seeks). Now a seek counts as stuck only after
 * `SEEK_STUCK_MS` of seeking with the film loaded past where it was sent, no
 * `seeked`, and no newer seek asked for; and a stuck seek is never re-seeked.
 *
 * The last rung ("rebuild") handed a streamed film to the browser's own
 * player, which in Chromium and Firefox cannot play HLS: any stall that got
 * that far left the film unplayable. It now does that only where the browser
 * can play HLS itself (Safari), and elsewhere rebuilds the streaming player.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "picture-token",
}))
const idleQueue = {
  active: false, playing: false, running: false, cellId: null, kind: "idle", errorMessage: null,
  progress: { currentTime: 0, duration: 0, rate: 1, volume: 1, programmeClock: false },
}
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueForFile: () => idleQueue,
  queueClockIsFileTime: () => false,
  useQueueAudibility: () => ({ source: true, target: true }),
  getQueueAudibility: () => ({ source: true, target: true }),
  setQueueAudibility: () => {},
  stopQueue: () => {},
  getQueueProgress: () => idleQueue.progress,
  tickProgrammeFilm: () => {},
  pauseQueue: () => {},
  resumeQueue: async () => {},
}))
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: () => {} }))
vi.mock("youtube-video-element", () => ({}))
/** The streaming player, as the pane drives it. */
const stream = vi.hoisted(() => ({
  pipeline: "native" as "native" | "hls",
  restartLoad: vi.fn(),
  recoverMedia: vi.fn(),
  fallbackToNative: vi.fn(),
}))
vi.mock("@/hooks/useHlsVideo", () => ({
  useHlsVideo: () => ({
    pipeline: stream.pipeline,
    restartLoad: stream.restartLoad,
    recoverMedia: stream.recoverMedia,
    fallbackToNative: stream.fallbackToNative,
    audioTracks: [],
    activeAudioLang: null,
    snapshot: () => ({}),
  }),
}))

import type { CellData } from "@/hooks/useCells"
import { MediaVideoPane } from "./MediaVideoPane"
import { SEEK_STUCK_MS } from "./video-stall"
import { getVideoBuffering, resetVideoClockForTests } from "@/lib/timeline/video-clock"

const cells = [
  { id: "s1", fileId: "f1", medium: "text", original: "Line one", translated: "", startTime: 0, endTime: 5 },
  { id: "s2", fileId: "f1", medium: "text", original: "Line two", translated: "", startTime: 10, endTime: 15 },
] as unknown as CellData[]

const loaded = (...ranges: Array<[number, number]>) => ({
  length: ranges.length,
  start: (i: number) => ranges[i]![0],
  end: (i: number) => ranges[i]![1],
})

/** One second of wall clock, flushed into the tree. */
const tick = (n = 1) => act(() => { vi.advanceTimersByTime(1000 * n) })

/** A film the person pressed Play on (standalone, following the source). */
function mount(src = "https://cdn/episode.webm") {
  const props = { src, fileId: "f1", cells, onVideoTime: vi.fn(), onVideoPlaying: vi.fn() }
  const view = render(<MediaVideoPane {...props} />)
  const writes: number[] = []
  const equip = (video: HTMLVideoElement, canPlayHls = "") => {
    let at = 12
    Object.defineProperty(video, "readyState", { value: 4, configurable: true })
    Object.defineProperty(video, "seeking", { value: false, configurable: true, writable: true })
    Object.defineProperty(video, "paused", { value: false, configurable: true, writable: true })
    Object.defineProperty(video, "ended", { value: false, configurable: true, writable: true })
    Object.defineProperty(video, "duration", { value: 60, configurable: true })
    Object.defineProperty(video, "buffered", { value: loaded([0, 40]), configurable: true, writable: true })
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => at,
      set: (v: number) => { at = v; writes.push(v) },
    })
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"]
    video.pause = vi.fn() as unknown as HTMLVideoElement["pause"]
    video.load = vi.fn() as unknown as HTMLVideoElement["load"]
    video.canPlayType = vi.fn(() => canPlayHls) as unknown as HTMLVideoElement["canPlayType"]
    return video
  }
  const video = equip(screen.getByTestId("video-pane-media") as HTMLVideoElement)
  view.rerender(<MediaVideoPane {...props} togglePlay={{ nonce: 1 }} />)
  /** The person (or the bar) asks the picture to go to `sec`. */
  let nonce = 0
  const seekTo = (sec: number) => view.rerender(<MediaVideoPane {...props} togglePlay={{ nonce: 1 }} seekSec={{ sec, nonce: ++nonce }} />)
  /** The element starts a seek of its own to `sec`, as a write would. */
  const seeking = (sec: number) => {
    Object.defineProperty(video, "seeking", { value: true, configurable: true, writable: true })
    video.currentTime = sec
    writes.length = 0
  }
  const lands = () => {
    Object.defineProperty(video, "seeking", { value: false, configurable: true, writable: true })
    fireEvent(video, new Event("seeked"))
  }
  return { video, writes, equip, seekTo, seeking, lands }
}

beforeEach(() => {
  resetVideoClockForTests()
  stream.pipeline = "native"
  stream.restartLoad.mockClear()
  stream.recoverMedia.mockClear()
  stream.fallbackToNative.mockClear()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe("a seek over film that has loaded", () => {
  it("SEEK_STUCK_MS is five seconds", () => {
    expect(SEEK_STUCK_MS).toBe(5_000)
  })

  it("a healthy 1.5 s seek is left alone", () => {
    const m = mount()
    m.seeking(30)
    tick(1)
    act(() => { vi.advanceTimersByTime(500); m.lands() })
    for (let i = 0; i < 5; i++) { m.video.currentTime = 31 + i; tick(1) }
    expect(getVideoBuffering()).toBe(false)
    expect(m.video.load).not.toHaveBeenCalled()
  })

  it("a slow seek that lands after 4 s is left alone, and nothing seeks on top of it", () => {
    const m = mount()
    m.seeking(30)
    tick(4)
    expect(m.writes).toEqual([])
    expect(getVideoBuffering()).toBe(false)
    m.lands()
    for (let i = 0; i < 4; i++) { m.video.currentTime = 31 + i; tick(1) }
    expect(getVideoBuffering()).toBe(false)
    expect(m.video.load).not.toHaveBeenCalled()
  })

  it("ten seeks in a row (scrubbing back) are left alone", () => {
    const m = mount()
    m.seeking(30)
    for (let i = 0; i < 10; i++) {
      m.seekTo(30 - i * 2) // held while the first is in flight, as the pane does
      tick(1)
    }
    expect(getVideoBuffering()).toBe(false)
    expect(m.writes).toEqual([])
    expect(m.video.load).not.toHaveBeenCalled()
  })

  it("a seek stuck for five seconds with the film loaded is recovered, without a second seek on top of it", () => {
    const m = mount()
    m.seeking(30)
    tick(SEEK_STUCK_MS / 1000 - 1)
    expect(getVideoBuffering()).toBe(false)
    tick(4)
    expect(getVideoBuffering()).toBe(true)
    // Straight to reopening the film where it was sent; no re-seek in flight.
    expect(m.video.load).toHaveBeenCalled()
    expect(m.writes).toEqual([])
  })

  it("a seek into film that has not loaded is waited on, however long", () => {
    const m = mount()
    Object.defineProperty(m.video, "buffered", { value: loaded([0, 21.5]), configurable: true, writable: true })
    m.seeking(26)
    tick(60)
    expect(getVideoBuffering()).toBe(false)
    expect(m.video.load).not.toHaveBeenCalled()
    expect(m.writes).toEqual([])
  })
})

describe("the last rung, rebuilding the player, on a streamed film", () => {
  /** A frozen clock (not a seek) through nudge, reopen and rebuild. */
  const climbToRebuild = () => {
    tick(3) // nudge
    tick(2) // reopen
    tick(3) // rebuild
  }

  it("in a browser that cannot play HLS itself (Chromium, Firefox), keeps the streaming player", () => {
    stream.pipeline = "hls"
    const m = mount("https://cdn/episode/master.m3u8")
    climbToRebuild()
    expect(stream.recoverMedia).toHaveBeenCalled()
    expect(stream.fallbackToNative).not.toHaveBeenCalled()
    // …and still a fresh element: the rung is a rebuild all the same.
    expect(screen.getByTestId("video-pane-media")).not.toBe(m.video)
  })

  it("in Safari, which plays HLS itself, hands the film to the browser's own player as before", () => {
    stream.pipeline = "hls"
    const m = mount("https://cdn/episode/master.m3u8")
    m.equip(m.video, "maybe")
    climbToRebuild()
    expect(stream.fallbackToNative).toHaveBeenCalled()
  })
})
