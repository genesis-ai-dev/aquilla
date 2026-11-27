import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  FILM_FRAME_BLANK_RETRIES,
  FILM_FRAME_CACHE_MAX,
  FilmFrameQueue,
  FrameUnavailableError,
  drawnFrameKind,
  drawUntilPictured,
  resetFilmFramesForTests,
  type CaptureFrame,
  type DrawnFrame,
} from "./film-frames"

// AQU-2253: where the film track's frames come from. One capture at a time,
// only what is in view, kept per film, and a film that gives none is left as
// the plain strip.
const flush = () => new Promise((r) => setTimeout(r, 0))

function deferredCapture() {
  const calls: { sec: number; resolve(url: string | null): void; reject(e: unknown): void }[] = []
  const capture: CaptureFrame = (sec) =>
    new Promise((resolve, reject) => {
      calls.push({ sec, resolve, reject })
    })
  return { capture, calls }
}

describe("FilmFrameQueue", () => {
  beforeEach(() => resetFilmFramesForTests())

  it("captures one frame at a time, in the order asked", async () => {
    const q = new FilmFrameQueue("film.webm")
    const { capture, calls } = deferredCapture()
    q.attach(capture)
    q.want([1, 2, 4])
    expect(calls.map((c) => c.sec)).toEqual([1])
    calls[0].resolve("data:1")
    await flush()
    expect(q.get(1)).toBe("data:1")
    expect(calls.map((c) => c.sec)).toEqual([1, 2])
  })

  it("only what is still in view: a new ask replaces the old one", async () => {
    const q = new FilmFrameQueue("film.webm")
    const { capture, calls } = deferredCapture()
    q.attach(capture)
    q.want([1, 2, 3])
    q.want([10, 11])
    calls[0].resolve("data:1")
    await flush()
    expect(calls.map((c) => c.sec)).toEqual([1, 10])
  })

  it("tells the strip when a frame arrives", async () => {
    const q = new FilmFrameQueue("film.webm")
    const { capture, calls } = deferredCapture()
    const changed = vi.fn()
    q.subscribe(changed)
    q.attach(capture)
    q.want([5])
    calls[0].resolve("data:5")
    await flush()
    expect(changed).toHaveBeenCalledOnce()
  })

  it("keeps each film's frames for the session, so a remount fetches nothing again", async () => {
    const first = new FilmFrameQueue("film.webm")
    const { capture, calls } = deferredCapture()
    first.attach(capture)
    first.want([3])
    calls[0].resolve("data:3")
    await flush()
    first.dispose()
    const again = new FilmFrameQueue("film.webm")
    const second = deferredCapture()
    again.attach(second.capture)
    again.want([3])
    expect(again.get(3)).toBe("data:3")
    expect(second.calls).toHaveLength(0)
    // …and another film's are its own.
    expect(new FilmFrameQueue("other.webm").get(3)).toBeNull()
  })

  it("keeps a bounded number of frames per film", async () => {
    const q = new FilmFrameQueue("film.webm")
    q.attach(async (sec) => `data:${sec}`)
    q.want(Array.from({ length: FILM_FRAME_CACHE_MAX + 20 }, (_, i) => i))
    for (let i = 0; i < FILM_FRAME_CACHE_MAX + 25; i++) await flush()
    expect(q.stats().cached).toBe(FILM_FRAME_CACHE_MAX)
    expect(q.get(0)).toBeNull()
    expect(q.get(FILM_FRAME_CACHE_MAX + 19)).toBe(`data:${FILM_FRAME_CACHE_MAX + 19}`)
  })

  it("a film that gives no frames is left alone after a few tries (the plain strip)", async () => {
    const q = new FilmFrameQueue("film.webm")
    const capture = vi.fn(async () => null)
    q.attach(capture)
    q.want([1, 2, 3, 4, 5, 6])
    for (let i = 0; i < 10; i++) await flush()
    expect(capture).toHaveBeenCalledTimes(3)
    expect(q.unavailable).toBe(true)
    q.want([7])
    await flush()
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it("one refusal that can never change is enough (a canvas the browser will not read)", async () => {
    const q = new FilmFrameQueue("film.webm")
    const capture = vi.fn(async () => {
      throw new FrameUnavailableError("tainted")
    })
    q.attach(capture)
    q.want([1, 2])
    for (let i = 0; i < 4; i++) await flush()
    expect(capture).toHaveBeenCalledOnce()
    expect(q.unavailable).toBe(true)
  })

  it("waits for an element to capture with", async () => {
    const q = new FilmFrameQueue("film.webm")
    const { capture, calls } = deferredCapture()
    q.want([2])
    expect(calls).toHaveLength(0)
    q.attach(capture)
    expect(calls.map((c) => c.sec)).toEqual([2])
  })

  it("measures what each frame costs", async () => {
    let t = 0
    const q = new FilmFrameQueue("film.webm", () => t)
    const { capture, calls } = deferredCapture()
    q.attach(capture)
    q.want([1])
    t = 40
    calls[0].resolve("data:1")
    await flush()
    expect(q.stats()).toMatchObject({ captured: 1, avgMs: 40, maxMs: 40 })
  })
})

// Safari's black tiles: a draw of the hidden film right after a seek can come
// back black, or with nothing in it, though the frame is there a beat later.
function pixels(...rgba: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat())
}

describe("drawnFrameKind", () => {
  it("a picture: any pixel brighter than black", () => {
    expect(drawnFrameKind(pixels([0, 0, 0, 255], [0, 0, 0, 255], [180, 40, 20, 255]))).toBe("picture")
  })

  it("black: every pixel drawn, none brighter than near-black", () => {
    expect(drawnFrameKind(pixels([0, 0, 0, 255], [12, 9, 16, 255]))).toBe("black")
  })

  it("empty: nothing was drawn at all", () => {
    expect(drawnFrameKind(pixels([0, 0, 0, 0], [0, 0, 0, 0]))).toBe("empty")
  })

  it("a bright pixel the draw never covered does not count", () => {
    expect(drawnFrameKind(pixels([0, 0, 0, 255], [255, 255, 255, 0]))).toBe("black")
  })
})

describe("drawUntilPictured", () => {
  function draws(...kinds: DrawnFrame[]) {
    let i = 0
    const settles: number[] = []
    return {
      draw: () => kinds[Math.min(i++, kinds.length - 1)],
      settle: async (retry: number) => {
        settles.push(retry)
      },
      count: () => i,
      settles,
    }
  }

  it("a picture on the first draw is kept, with no waiting", async () => {
    const d = draws("picture")
    expect(await drawUntilPictured(d.draw, d.settle)).toBe("picture")
    expect(d.count()).toBe(1)
    expect(d.settles).toEqual([])
  })

  it("a blank draw waits a beat and draws again, until the picture comes", async () => {
    const d = draws("black", "empty", "picture")
    expect(await drawUntilPictured(d.draw, d.settle)).toBe("picture")
    expect(d.count()).toBe(3)
    expect(d.settles).toEqual([1, 2])
  })

  it("gives up after a few tries: black then is the film's own black", async () => {
    const d = draws("black")
    expect(await drawUntilPictured(d.draw, d.settle)).toBe("black")
    expect(d.count()).toBe(1 + FILM_FRAME_BLANK_RETRIES)
    expect(d.settles).toEqual([1, 2, 3])
  })

  it("and a draw that never held anything says so", async () => {
    const d = draws("empty")
    expect(await drawUntilPictured(d.draw, d.settle)).toBe("empty")
    expect(d.count()).toBe(1 + FILM_FRAME_BLANK_RETRIES)
  })
})
