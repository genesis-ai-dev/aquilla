// WHY these tests exist: a single-slot version of this store looked equivalent
// and silently lost the duration on the ordinary two-files-two-videos path, so
// the keying is pinned. "Not known" must also stay distinguishable from zero —
// the first falls back to the cells' extent, the second would collapse the
// track to nothing.

import { describe, expect, it, beforeEach } from "vitest"
import {
  getVideoDurationSec,
  resetVideoDurationsForTests,
  setVideoDurationSec,
} from "./video-duration"

describe("video-duration", () => {
  beforeEach(() => resetVideoDurationsForTests())

  it("stores and reads back a duration by url", () => {
    setVideoDurationSec("https://cdn/a.m3u8", 4212.096)
    expect(getVideoDurationSec("https://cdn/a.m3u8")).toBeCloseTo(4212.096, 3)
  })

  it("keeps two videos apart, and surviving a round trip between them", () => {
    setVideoDurationSec("https://cdn/a.mp4", 120)
    setVideoDurationSec("https://cdn/b.mp4", 300)
    expect(getVideoDurationSec("https://cdn/a.mp4")).toBe(120)
    expect(getVideoDurationSec("https://cdn/b.mp4")).toBe(300)
  })

  it("returns null for an unknown url, and for no url at all", () => {
    expect(getVideoDurationSec("https://cdn/never-seen.mp4")).toBeNull()
    expect(getVideoDurationSec(null)).toBeNull()
    expect(getVideoDurationSec(undefined)).toBeNull()
  })

  it.each([null, 0, -3, NaN, Infinity, 7 * 60 * 60])(
    "refuses %p rather than storing it",
    (bad) => {
      setVideoDurationSec("https://cdn/a.mp4", bad as number | null)
      expect(getVideoDurationSec("https://cdn/a.mp4")).toBeNull()
    },
  )

  it("a later null CLEARS a known duration — the video was swapped or failed", () => {
    setVideoDurationSec("https://cdn/a.mp4", 120)
    setVideoDurationSec("https://cdn/a.mp4", null)
    expect(getVideoDurationSec("https://cdn/a.mp4")).toBeNull()
  })

  it("evicts the oldest url past the cap, and keeps the freshest", () => {
    for (let i = 0; i < 9; i++) setVideoDurationSec(`https://cdn/${i}.mp4`, 100 + i)
    expect(getVideoDurationSec("https://cdn/0.mp4")).toBeNull() // evicted
    expect(getVideoDurationSec("https://cdn/8.mp4")).toBe(108)
  })

  it("a repeat write refreshes an entry's place in the eviction order", () => {
    for (let i = 0; i < 8; i++) setVideoDurationSec(`https://cdn/${i}.mp4`, 100 + i)
    // Re-assert 0 with a NEW value so it re-inserts at the back of the queue.
    setVideoDurationSec("https://cdn/0.mp4", 999)
    setVideoDurationSec("https://cdn/new.mp4", 500)
    expect(getVideoDurationSec("https://cdn/0.mp4")).toBe(999)
    expect(getVideoDurationSec("https://cdn/1.mp4")).toBeNull() // now the oldest
  })
})
