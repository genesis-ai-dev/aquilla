// AQU-646 stage 2 — the collapsed folder's summary band.

import { describe, expect, it } from "vitest"
import { summaryBlocks, SUMMARY_MERGE_GAP_PX, type SummarySpan } from "./summary-band"

const span = (startSec: number, endSec: number): SummarySpan => ({ startSec, endSec })

/** A wide-open window at 40px/sec — the zoom the timeline's own tests use. */
const VIEW = { viewStartSec: 0, viewEndSec: 1000, pxPerSec: 40 }

describe("summaryBlocks — the picture", () => {
  it("draws well-separated spans as themselves", () => {
    expect(summaryBlocks([span(0, 2), span(10, 12)], VIEW)).toEqual([span(0, 2), span(10, 12)])
  })

  it("sorts the union — the spans arrive from several tracks concatenated", () => {
    expect(summaryBlocks([span(10, 12), span(0, 2)], VIEW)).toEqual([span(0, 2), span(10, 12)])
  })

  it("merges touching spans", () => {
    expect(summaryBlocks([span(0, 2), span(2, 4)], VIEW)).toEqual([span(0, 4)])
  })

  // Two dub tracks in one folder is the common case for this, and the summary
  // answers "is there material here", not "how many layers of it".
  it("merges overlapping spans", () => {
    expect(summaryBlocks([span(0, 5), span(3, 8)], VIEW)).toEqual([span(0, 8)])
  })

  // Math.max, not "take the later end": a long span can wholly contain a later
  // short one, and taking the later end would SHORTEN the block.
  it("keeps the longer end when one span contains another", () => {
    expect(summaryBlocks([span(0, 20), span(5, 6)], VIEW)).toEqual([span(0, 20)])
  })
})

describe("summaryBlocks — coalescing is measured in pixels, not seconds", () => {
  it("merges a gap narrower than the threshold at this zoom", () => {
    // 40px/sec → the 3px threshold is 0.075s. A 0.05s gap disappears.
    expect(summaryBlocks([span(0, 2), span(2.05, 4)], VIEW)).toEqual([span(0, 4)])
  })

  it("keeps a gap wider than the threshold at this zoom", () => {
    expect(summaryBlocks([span(0, 2), span(2.5, 4)], VIEW)).toEqual([span(0, 2), span(2.5, 4)])
  })

  // The same two spans, the same gap in seconds, a different answer — because
  // the question is whether the gap is VISIBLE. In seconds this constant would
  // have to be re-tuned at every zoom level.
  it("gives the same gap opposite answers at opposite zooms", () => {
    const spans = [span(0, 2), span(2.5, 4)]
    expect(summaryBlocks(spans, { ...VIEW, pxPerSec: 1 })).toEqual([span(0, 4)])
    expect(summaryBlocks(spans, { ...VIEW, pxPerSec: 40 })).toHaveLength(2)
  })

  // THE CASE THIS MODULE EXISTS FOR. 800 cues across a 70-minute episode, zoomed
  // out to fit — drawn faithfully that is 800 positioned divs producing a grey
  // smear, on a row the user has explicitly said they are not looking at.
  it("turns a whole episode's cues into a handful of blocks when zoomed out", () => {
    const cues: SummarySpan[] = []
    for (let i = 0; i < 800; i += 1) cues.push(span(i * 5, i * 5 + 4.9))
    const view = { viewStartSec: 0, viewEndSec: 4000, pxPerSec: 1400 / 4000 }
    const blocks = summaryBlocks(cues, view)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toEqual(span(0, 3999.9))
  })

  it("…and still shows the gaps once you zoom into them", () => {
    const cues: SummarySpan[] = []
    for (let i = 0; i < 800; i += 1) cues.push(span(i * 5, i * 5 + 4.9))
    // Six cues start inside 0–30s, and at 40px/sec their 0.1s gaps are 4px —
    // over the threshold, so every one of them survives as its own block.
    const blocks = summaryBlocks(cues, { viewStartSec: 0, viewEndSec: 30, pxPerSec: 40 })
    expect(blocks.length).toBe(6)
    expect(blocks[0]).toEqual(span(0, 4.9))
  })

  it("merges only what touches when the scale is unusable", () => {
    for (const pxPerSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const view = { ...VIEW, pxPerSec }
      expect(summaryBlocks([span(0, 2), span(2, 4)], view)).toEqual([span(0, 4)])
      expect(summaryBlocks([span(0, 2), span(2.01, 4)], view)).toHaveLength(2)
    }
  })
})

describe("summaryBlocks — culling", () => {
  it("drops spans outside the window, so a collapsed folder costs no more than an open one", () => {
    const spans = [span(0, 2), span(100, 102), span(200, 202)]
    expect(summaryBlocks(spans, { viewStartSec: 90, viewEndSec: 110, pxPerSec: 40 })).toEqual([span(100, 102)])
  })

  it("keeps a span straddling either edge", () => {
    const spans = [span(80, 95), span(105, 120)]
    expect(summaryBlocks(spans, { viewStartSec: 90, viewEndSec: 110, pxPerSec: 40 })).toEqual(spans)
  })

  it("returns nothing for an empty folder or an empty window", () => {
    expect(summaryBlocks([], VIEW)).toEqual([])
    expect(summaryBlocks([span(0, 2)], { viewStartSec: 500, viewEndSec: 600, pxPerSec: 40 })).toEqual([])
  })
})

describe("summaryBlocks — totality", () => {
  // These come from cell timings, and a cell with a missing or reversed timing
  // is a real state on imported data. The summary is an at-a-glance picture;
  // the honest thing to do with a span that has no length is not draw it.
  it("skips spans that are not two finite ascending numbers", () => {
    const spans = [
      span(Number.NaN, 2),
      span(0, Number.NaN),
      span(5, 5),
      span(8, 6),
      span(Number.NEGATIVE_INFINITY, 1),
      span(10, 12),
    ]
    expect(summaryBlocks(spans, VIEW)).toEqual([span(10, 12)])
  })

  it("never mutates its input", () => {
    const spans = [span(10, 12), span(0, 2)]
    const snapshot = JSON.parse(JSON.stringify(spans))
    summaryBlocks(spans, VIEW)
    expect(spans).toEqual(snapshot)
  })
})

describe("the threshold itself", () => {
  it("is a small number of pixels — a gap survives if you could have seen it", () => {
    expect(SUMMARY_MERGE_GAP_PX).toBeGreaterThan(0)
    expect(SUMMARY_MERGE_GAP_PX).toBeLessThanOrEqual(4)
  })
})
