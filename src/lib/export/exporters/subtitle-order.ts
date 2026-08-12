// Cue ordering for the subtitle serializers. (AQU-646)
//
// The exporters are fed anchor-CHAIN order (ExportDialog passes
// cellStore.getAllCellViews()), which is the order rows were threaded together,
// not the order they are heard. Those agree until someone edits the timeline:
// a retimed cue keeps its chain position while its clock moves, and before the
// mid-file re-point fix an added line sat at the tail of the chain entirely.
// A subtitle file in the wrong order is not a cosmetic problem — players honour
// the timestamps but tools that read cues sequentially do not.
//
// Sorting here rather than in ExportDialog keeps it with the formats that
// actually care (VTT/SRT are the only timed ones) and covers every caller,
// including the project-zip path that never touches the dialog.

import type { CellData } from "@/hooks/useCells"

/** A copy, ordered by start time. Stable, so cues sharing a start keep their
 *  document order — real VTTs do contain simultaneous speakers. Untimed cells
 *  keep their relative position and are dropped by the callers anyway. */
export function sortedByTime(cells: readonly CellData[]): CellData[] {
  return [...cells].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
}
