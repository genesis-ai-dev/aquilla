// AQU-646 stage 5: one seek in flight, always.
//
// happy-dom's media element is inert and never fires `seeked`, which is exactly
// why this is a pure function over an explicit record — the same reasoning
// `video-sync.ts` gives for its own shape.
import { describe, it, expect } from "vitest"
import { nextScrubSeek } from "./video-seek-coalesce"

const idle = { seeking: false, pendingSec: null }

describe("nextScrubSeek", () => {
  it("issues immediately when the element is not already seeking", () => {
    expect(nextScrubSeek({ ...idle, requestSec: 12 })).toEqual({ seekSec: 12, pendingSec: null })
  })

  // The burst guard. hls.js "stops producing frames without firing an event"
  // after a run of overlapping seeks, so a second one never goes out while the
  // first is unfinished.
  it("holds a target rather than stacking a second seek on a seeking element", () => {
    expect(nextScrubSeek({ seeking: true, pendingSec: null, requestSec: 12 })).toEqual({
      seekSec: null,
      pendingSec: 12,
    })
  })

  it("keeps only the newest target while the element is busy", () => {
    // Everything the hand did mid-seek collapses to where it ended up.
    let s = nextScrubSeek({ seeking: true, pendingSec: null, requestSec: 12 })
    s = nextScrubSeek({ seeking: true, pendingSec: s.pendingSec, requestSec: 13 })
    s = nextScrubSeek({ seeking: true, pendingSec: s.pendingSec, requestSec: 14 })
    expect(s).toEqual({ seekSec: null, pendingSec: 14 })
  })

  // THE TRAILING EDGE, which is the whole reason this is not a timer: the last
  // place the user asked for is sitting in `pendingSec`, so draining on `seeked`
  // is what guarantees the picture ends up where the hand stopped.
  it("drains the held target when the element settles", () => {
    expect(nextScrubSeek({ seeking: false, pendingSec: 14, requestSec: null })).toEqual({
      seekSec: 14,
      pendingSec: null,
    })
  })

  it("does nothing on a settle with nothing held", () => {
    expect(nextScrubSeek({ ...idle, requestSec: null })).toEqual({ seekSec: null, pendingSec: null })
  })

  it("a full drag: every intermediate collapses, the last one lands", () => {
    let pendingSec: number | null = null
    const issued: number[] = []
    const request = (sec: number, seeking: boolean) => {
      const out = nextScrubSeek({ seeking, pendingSec, requestSec: sec })
      pendingSec = out.pendingSec
      if (out.seekSec != null) issued.push(out.seekSec)
    }
    const settled = () => {
      const out = nextScrubSeek({ seeking: false, pendingSec, requestSec: null })
      pendingSec = out.pendingSec
      if (out.seekSec != null) issued.push(out.seekSec)
    }
    request(1, false) // lands
    request(2, true)
    request(3, true)
    request(4, true)
    settled() // drains 4
    request(5, true)
    settled() // drains 5
    settled() // nothing left
    expect(issued).toEqual([1, 4, 5])
    expect(pendingSec).toBeNull()
  })

  // A missed `seeked` — an error, a source swap, a rebuild after a stall —
  // must not deadlock the picture. Reading the element's live flag rather than
  // our own bookkeeping is what makes the next request recover on its own.
  it("recovers on the next request when a settle never arrives", () => {
    const held = nextScrubSeek({ seeking: true, pendingSec: null, requestSec: 12 })
    expect(held.seekSec).toBeNull()
    expect(nextScrubSeek({ seeking: false, pendingSec: held.pendingSec, requestSec: 20 })).toEqual({
      seekSec: 20,
      pendingSec: null,
    })
  })

  it("refuses a target that is not a real second, without losing a good one", () => {
    expect(nextScrubSeek({ seeking: true, pendingSec: 9, requestSec: Number.NaN })).toEqual({
      seekSec: null,
      pendingSec: 9,
    })
    expect(nextScrubSeek({ ...idle, requestSec: Number.POSITIVE_INFINITY })).toEqual({
      seekSec: null,
      pendingSec: null,
    })
  })
})
