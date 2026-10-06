// bible-span — what one span gets from Bible data (AQU-1690).
//
// The tick builds this from the wave's BibleRunData (./bible-run.ts) and
// hands it to runSpan. Everything here is data or an injected function, so
// the pipeline stays pure composition and its tests script every edge.

import type { BibleRunData } from "./bible-run"

export interface SpanBible {
  /** Short facts per cell id, for scene construal (who speaks to whom, who is named). */
  construeFacts: ReadonlyMap<string, string>
  /** Full facts per cell id, for the drafter and the verifiers. */
  draftFacts: ReadonlyMap<string, string>
}

/** The span's view of the wave's Bible data. */
export function spanBible(data: BibleRunData): SpanBible {
  return { construeFacts: data.construeLines, draftFacts: data.draftLines }
}
