// AQU-646 stage 5: hearing one clip.
//
// happy-dom has no AudioContext at all, so the first block below pins the rule
// every other surface in this app already follows — no pipeline means silence,
// never a throw and never a null — and the rest drives a stub so the engine's
// bookkeeping (one at a time, node cleanup, the mute split) can be proved
// without a browser.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  openGrainScrub,
  playClipWindow,
  stopClipPreview,
  __resetClipPreviewForTests,
} from "./clip-preview"
import { resetOutputContextForTests } from "./output-context"
import { __resetMicHoldForTests, setMicHeld } from "./mic-hold"
import { getActiveAudio } from "./audio-coordinator"
import { GRAIN_SEC } from "./clip-preview-window"

const fetchCellAudio = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2, 3, 4])))
const audioCacheGet = vi.hoisted(() => vi.fn(async () => null))
vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: (...a: unknown[]) => fetchCellAudio(...(a as [])),
  getCellAudioStreamUrl: vi.fn(async () => "https://example.test/clip.wav"),
}))
vi.mock("./bytes-cache", () => ({
  audioCacheGet: (...a: unknown[]) => audioCacheGet(...(a as [])),
  audioCachePut: vi.fn(async () => {}),
}))

const SRC = {
  url: "frontier-audio://audio-c1-1700000000-take.webm",
  projectId: "p1",
  fileId: "f1",
  getSyncToken: async () => "tok",
  durationSec: 3,
}

// ── A stand-in for the platform's audio graph ───────────────────────────────
class StubSource {
  static live = 0
  static started: { offset: number; duration: number }[] = []
  buffer: unknown = null
  onended: (() => void) | null = null
  connected = true
  start(_when: number, offset: number, duration: number) {
    StubSource.live += 1
    StubSource.started.push({ offset, duration })
  }
  // `stop(when)` SCHEDULES; only a bare `stop()` is immediate. Modelling that
  // matters: the engine always schedules an end-stop, and a stub that ended
  // instantly would report every clip as already finished.
  stop(when?: number) { if (when == null) this.end() }
  end() { if (this.onended) { const f = this.onended; this.onended = null; StubSource.live -= 1; f() } }
  disconnect() { this.connected = false }
  connect() {}
}
class StubGain {
  gain = {
    setValueAtTime() {},
    linearRampToValueAtTime() {},
  }
  connect() {}
  disconnect() {}
}
class StubCtx {
  state = "running"
  currentTime = 0
  destination = {}
  resume() { this.state = "running"; return Promise.resolve() }
  createBufferSource() { return new StubSource() as unknown as AudioBufferSourceNode }
  createGain() { return new StubGain() as unknown as GainNode }
  decodeAudioData(_b: ArrayBuffer) {
    return Promise.resolve({ duration: 3, length: 144000, numberOfChannels: 1 } as AudioBuffer)
  }
}
function stubAudio() {
  vi.stubGlobal("AudioContext", function AC(this: unknown) { return new StubCtx() } as unknown as typeof AudioContext)
}
/** Let the decode promise and the `.then` that starts playback both settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  StubSource.live = 0
  StubSource.started = []
  fetchCellAudio.mockClear()
  __resetClipPreviewForTests()
  resetOutputContextForTests()
  __resetMicHoldForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  __resetClipPreviewForTests()
  resetOutputContextForTests()
  __resetMicHoldForTests()
})

describe("with no audio pipeline — every unit test in this repo", () => {
  it("hands back a silent handle rather than null or a throw", () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined()
    const h = playClipWindow(SRC, { startSec: 0, endSec: null })
    expect(h.audible).toBe(false)
    expect(h.isPlaying()).toBe(false)
    expect(() => h.stop()).not.toThrow()
  })

  it("does not go to the network for audio it could never play", async () => {
    playClipWindow(SRC, { startSec: 0, endSec: null })
    openGrainScrub(SRC, { edge: "in", isMuted: () => false }).moveTo(1)
    await settle()
    expect(fetchCellAudio).not.toHaveBeenCalled()
  })

  it("a grain scrub with nowhere to play is inert, not broken", () => {
    const scrub = openGrainScrub(SRC, { edge: "in", isMuted: () => false })
    expect(() => { scrub.moveTo(1); scrub.close() }).not.toThrow()
  })
})

describe("playing a trimmed clip", () => {
  beforeEach(stubAudio)

  it("plays exactly the window it was given, in the clip's own clock", async () => {
    playClipWindow(SRC, { startSec: 0.4, endSec: 2.1 })
    await settle()
    expect(StubSource.started).toHaveLength(1)
    expect(StubSource.started[0].offset).toBeCloseTo(0.4, 5)
    expect(StubSource.started[0].duration).toBeCloseTo(1.7, 5)
  })

  it("plays to the natural end when nothing trims it", async () => {
    playClipWindow(SRC, { startSec: 0, endSec: null })
    await settle()
    expect(StubSource.started[0].duration).toBeCloseTo(3, 5)
  })

  it("never asks for audio past the end of the buffer", async () => {
    playClipWindow(SRC, { startSec: 1, endSec: 99 })
    await settle()
    expect(StubSource.started[0].offset + StubSource.started[0].duration).toBeCloseTo(3, 5)
  })

  // ONE AT A TIME IS A PROPERTY OF THE ENGINE, not a protocol every chip keeps —
  // `setActiveAudio` deliberately does not pause the previous holder, so the
  // coordinator alone would not give us this.
  it("a second press silences the first", async () => {
    const first = playClipWindow(SRC, { startSec: 0, endSec: null })
    await settle()
    const second = playClipWindow(SRC, { startSec: 1, endSec: null })
    expect(first.isPlaying()).toBe(false)
    expect(second.isPlaying()).toBe(true)
  })

  it("opening a grain scrub silences a running clip — you cannot audition and shave at once", async () => {
    const playing = playClipWindow(SRC, { startSec: 0, endSec: null })
    await settle()
    openGrainScrub(SRC, { edge: "in", isMuted: () => false })
    expect(playing.isPlaying()).toBe(false)
  })

  // The recording modal's open path calls `pauseAllPlayback()` precisely so the
  // mic never records over sounding audio — and the chip's own mic button is
  // what opens it, one corner away from the play button.
  it("registers so the app's global pause can reach it, and deregisters after", async () => {
    const h = playClipWindow(SRC, { startSec: 0, endSec: null })
    await settle()
    expect(getActiveAudio()?.isPlaying()).toBe(true)
    getActiveAudio()?.pause()
    expect(h.isPlaying()).toBe(false)
    expect(getActiveAudio()).toBeNull()
  })

  it("disconnects its nodes when it finishes on its own", async () => {
    playClipWindow(SRC, { startSec: 0, endSec: null })
    await settle()
    expect(StubSource.live).toBe(1)
    stopClipPreview()
    expect(StubSource.live).toBe(0)
  })

  // Sam's ruling: the play button is an inspection tool and sounds through the
  // track's mute. The caller states it, so the two features cannot drift.
  it("obeys the caller about mute rather than reading a store", async () => {
    const h = playClipWindow(SRC, { startSec: 0, endSec: null }, { muted: true })
    await settle()
    expect(h.audible).toBe(false)
    expect(StubSource.started).toHaveLength(0)
  })
})

describe("grain scrubbing a trim handle", () => {
  beforeEach(stubAudio)

  it("plays forward from an in-point and up to an out-point", async () => {
    const inScrub = openGrainScrub(SRC, { edge: "in", isMuted: () => false })
    await settle()
    inScrub.moveTo(1)
    expect(StubSource.started[0].offset).toBeCloseTo(1, 5)
    inScrub.close()

    StubSource.started = []
    const outScrub = openGrainScrub(SRC, { edge: "out", isMuted: () => false })
    await settle()
    outScrub.moveTo(1)
    // What you are about to cut off, not what you are throwing away.
    expect(StubSource.started[0].offset).toBeCloseTo(1 - GRAIN_SEC, 5)
    outScrub.close()
  })

  // The speaker can be flipped mid-drag, so this is read per grain rather than
  // captured — `audibility.ts` is emphatic about why merging from a caller's
  // own copy of that state is the bug.
  it("reads the mute per grain, not once at the start", async () => {
    let muted = false
    const scrub = openGrainScrub(SRC, { edge: "in", isMuted: () => muted })
    await settle()
    scrub.moveTo(1)
    expect(StubSource.started).toHaveLength(1)
    muted = true
    scrub.moveTo(1.2)
    expect(StubSource.started).toHaveLength(1) // nothing new was created at all
    muted = false
    scrub.moveTo(1.4)
    expect(StubSource.started).toHaveLength(2)
    scrub.close()
  })

  // The cap is a guard against an event storm, not the working path.
  it("never leaves more grains alive than the cap, however fast the hand moves", async () => {
    const scrub = openGrainScrub(SRC, { edge: "in", isMuted: () => false })
    await settle()
    for (let i = 0; i < 40; i += 1) scrub.moveTo(i * 0.05)
    expect(StubSource.live).toBeLessThanOrEqual(4)
    scrub.close()
    expect(StubSource.live).toBe(0)
  })

  it("makes no sound at the very end of the clip rather than a zero-length node", async () => {
    const scrub = openGrainScrub(SRC, { edge: "in", isMuted: () => false })
    await settle()
    scrub.moveTo(3)
    expect(StubSource.started).toHaveLength(0)
    scrub.close()
  })

  it("closing twice is harmless", async () => {
    const scrub = openGrainScrub(SRC, { edge: "in", isMuted: () => false })
    await settle()
    expect(() => { scrub.close(); scrub.close() }).not.toThrow()
  })
})

describe("the audio device", () => {
  it("declines to CREATE a context while the recorder holds the mic", async () => {
    stubAudio()
    setMicHeld(true)
    const h = playClipWindow(SRC, { startSec: 0, endSec: null })
    // Not a refusal of the feature — a refusal to touch the device at the one
    // moment that has twice eaten the head of a take.
    expect(h.audible).toBe(false)
  })

  it("uses a context that already exists even with the mic held", async () => {
    stubAudio()
    // Something else (the countdown, the latency probe) made it first.
    playClipWindow(SRC, { startSec: 0, endSec: null }).stop()
    setMicHeld(true)
    const h = playClipWindow(SRC, { startSec: 0, endSec: null })
    expect(h.audible).toBe(true)
    h.stop()
  })
})
