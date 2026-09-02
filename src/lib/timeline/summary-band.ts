// AQU-646 stage 2: what a COLLAPSED folder draws on its own lane.
//
// Logic's folder stacks do this: fold the stack and the folder's own track
// shows a compressed picture of the regions inside it, so you can still see
// where there is material without the rows being open. This is that picture.
//
// IT IS SPANS, NOT TAKES, AND THAT IS DELIBERATE. A folder can hold any track —
// a dub row, a source-audio row of imported cues, the subtitle row — so the
// summary cannot be built from anything take-shaped. It takes plain
// start/end seconds, which every lane can produce, and knows nothing about what
// drew them.
//
// COALESCING IS THE WHOLE JOB, NOT A REFINEMENT. A 70-minute episode carries
// ~800 cues; at a zoom where the whole file fits on screen those are ~2px each
// with sub-pixel gaps. Drawn faithfully that is 800 absolutely-positioned divs
// producing a grey smear — every one of them a layout box the browser has to
// keep, on a row the user has explicitly said they are not looking at. Merging
// anything whose gap is under a pixel or two gives the same picture in a
// handful of elements, and gets more accurate as you zoom in rather than less.

import { isVisible } from "./scale"

export interface SummarySpan {
  startSec: number
  endSec: number
}

/**
 * Two spans closer than this on screen are drawn as one.
 *
 * Chosen in PIXELS rather than seconds because that is the unit the decision is
 * actually in: whether a gap is visible at all. In seconds it would have to be
 * re-tuned at every zoom level, and would either shatter when zoomed out or
 * over-merge when zoomed in. At 3px a gap survives if you could have seen it.
 */
export const SUMMARY_MERGE_GAP_PX = 3

/**
 * The blocks to draw for a collapsed folder, in order.
 *
 * Culled to the visible window with the same `isVisible` every lane uses, so a
 * collapsed folder costs no more than an open one; then coalesced.
 *
 * TOTAL ON MALFORMED INPUT rather than throwing: these spans come from cell
 * timings, and a cell with a missing or reversed timing is a real state on
 * imported data. A span that is not two finite ascending numbers is skipped —
 * the summary is an at-a-glance picture, and the honest thing to do with a
 * span that has no length is to not draw it.
 *
 * Overlapping spans merge as readily as adjacent ones. On a folder holding two
 * dub tracks that is the common case, and it is correct: the summary answers
 * "is there material here", not "how many layers of it".
 */
export function summaryBlocks(
  spans: readonly SummarySpan[],
  view: { viewStartSec: number; viewEndSec: number; pxPerSec: number },
): SummarySpan[] {
  const { viewStartSec, viewEndSec, pxPerSec } = view

  const visible: SummarySpan[] = []
  for (const span of spans) {
    const { startSec, endSec } = span
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue
    if (!(endSec > startSec)) continue
    if (!isVisible(startSec, endSec, viewStartSec, viewEndSec)) continue
    visible.push({ startSec, endSec })
  }
  if (visible.length === 0) return []

  // Sorted here rather than assumed: the spans arrive from several tracks
  // concatenated, so even if each track's own list is ordered, the union is not.
  visible.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)

  // A non-positive or non-finite pxPerSec cannot express a pixel gap; merge
  // only what actually touches, which is the answer that needs no scale.
  const gapSec = Number.isFinite(pxPerSec) && pxPerSec > 0 ? SUMMARY_MERGE_GAP_PX / pxPerSec : 0

  const blocks: SummarySpan[] = []
  let current = visible[0]
  for (let i = 1; i < visible.length; i += 1) {
    const next = visible[i]
    if (next.startSec - current.endSec <= gapSec) {
      // `Math.max`, not `next.endSec`: a long span can wholly contain a later
      // short one, and taking the later end would shorten the block.
      if (next.endSec > current.endSec) current = { startSec: current.startSec, endSec: next.endSec }
      continue
    }
    blocks.push(current)
    current = next
  }
  blocks.push(current)
  return blocks
}
