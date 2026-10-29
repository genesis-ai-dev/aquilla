// AQU-1758 (Sam, Oct 29): picking a chapter in the picker while Play all is
// playing jumps to that chapter and keeps playing, from its first line, in
// both timings. Picking one while playback is paused still ends that playback,
// and picking the chapter that is playing changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyChapterPick, planChapterPick } from "./chapter-pick"
import type { TimelineChapter } from "./sequence-timeline"
import { getQueueState, setQueueTimingMode, startQueue, stopQueue, type PlayContext } from "@/lib/audio/play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  currentTime = 0
  duration = 600
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  readyState = 4
  preload = ""
  error = null
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
    queueMicrotask(() => this.onloadedmetadata?.())
  }
  async play(): Promise<void> {
    this.paused = false
    this.onplay?.()
  }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(() => fn())
  }
  removeEventListener(): void {}
}

/** A verse of a book, recorded: a take of 2 s. */
function verse(id: string): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: 2000 } },
  } as unknown as CellData
}

const RUTH = [verse("r1v1"), verse("r1v2"), verse("r2v1"), verse("r2v2")]
const CHAPTERS: TimelineChapter[] = [
  { key: "RUT 1", cellIds: ["r1v1", "r1v2"] },
  { key: "RUT 2", cellIds: ["r2v1", "r2v2"] },
]
const session = { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"]
const take = (id: string) => [...FakeAudio.instances].reverse().find((a) => a.src.includes(`/${id}.webm`))
const settle = () => vi.advanceTimersByTimeAsync(0)

describe("planChapterPick", () => {
  const plan = (pickedKey: string, playingKey: string | null, queueKind: ReturnType<typeof getQueueState>["kind"]) =>
    planChapterPick({ chapters: CHAPTERS, lines: RUTH, pickedKey, playingKey, queueKind })

  it("while playing another chapter: play the picked one", () => {
    expect(plan("RUT 2", "RUT 1", "playing")).toEqual({ kind: "play", chapter: CHAPTERS[1] })
    expect(plan("RUT 2", "RUT 1", "loading")).toEqual({ kind: "play", chapter: CHAPTERS[1] })
  })

  it("while paused on another chapter: stop, as before", () => {
    expect(plan("RUT 2", "RUT 1", "paused")).toEqual({ kind: "stop" })
  })

  it("the chapter that is playing, or nothing playing on this file: only show it", () => {
    expect(plan("RUT 1", "RUT 1", "playing")).toEqual({ kind: "show" })
    expect(plan("RUT 2", null, "idle")).toEqual({ kind: "show" })
  })

  it("a picked chapter with nothing to play: stop", () => {
    const silent = [...RUTH.slice(0, 2), { ...verse("r2v1"), selectedAudioId: undefined, attachments: {} } as unknown as CellData]
    expect(
      planChapterPick({ chapters: CHAPTERS, lines: silent, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing" }),
    ).toEqual({ kind: "stop" })
  })
})

describe.each([
  ["following the source", "dubbing"],
  ["following the recordings", "audioFirst"],
] as const)("picking Ruth 2 during Play all of Ruth 1, %s", (_label, mode) => {
  beforeEach(() => {
    FakeAudio.instances = []
    vi.stubGlobal("Audio", FakeAudio)
    vi.useFakeTimers()
    setQueueTimingMode(mode)
  })
  afterEach(() => {
    stopQueue()
    setQueueTimingMode("dubbing")
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("jumps to Ruth 2's first line and keeps playing", async () => {
    startQueue({ cells: RUTH.slice(0, 2), projectId: "p1", session }, 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r1v1" })

    const plan = planChapterPick({ chapters: CHAPTERS, lines: RUTH, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: getQueueState().kind })
    applyChapterPick(plan, { lines: RUTH, projectId: "p1", session })
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r2v1" })
    expect(take("r2v1")?.paused).toBe(false)
    // Nothing of Ruth 1 sounds any more.
    expect(FakeAudio.instances.filter((a) => a.src.includes("/r1v") && !a.paused)).toHaveLength(0)
  })
})
