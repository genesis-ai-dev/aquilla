// AQU-1702: "put this file in that group". The sidebar's cross-group drag and
// its ⋯ fallback both ask this module what a move means before anything is
// written, so the gesture and the menu can never disagree.
//
// A move is two writes, and they are not the same event: the group itself is
// `file.corpus.set` (the marker), the slot inside the group is `file.reorder`
// (the index, from `planFileInsert`). This module decides the marker and asks
// for the index; it never computes an index itself.
//
// It also owns the one refusal. `groupByCorpus` resolves a file with no marker
// by its Bible book code, so a Bible book dropped on "Ungrouped" would come
// straight back to OT/NT — a drop that looks like it worked and did nothing.
// AQU-1702 asks for that case to say why instead of moving silently.

import {
  UNGROUPED_GROUP,
  groupLabelForMarker,
  sameGroup,
  type GroupableFile,
} from "./group-by-corpus"
import { planFileInsert, type PlaceableFile, type SortIndexWrite } from "./file-sort-index"

/** The file a regroup moves: identity, what it groups by, where it sits. */
export type RegroupableFile = GroupableFile & PlaceableFile

export type FileRegroupPlan =
  /** The marker to write, and the index writes that land it in the slot. */
  | { ok: true; corpusMarker: string | null; writes: SortIndexWrite[] }
  /**
   * The drop cannot be expressed: the file would be filed under `landsIn`
   * rather than the group it was dropped on. Carries both labels so the
   * message can name them.
   */
  | { ok: false; reason: "derived-group"; targetGroup: string; landsIn: string }

export interface FileRegroupRequest {
  file: RegroupableFile & { id: string }
  /** `CorpusGroup.label` of the group the file was dropped on. */
  targetGroup: string
  /** The target group's current visual order, WITHOUT the moved file. */
  targetFiles: readonly PlaceableFile[]
  /**
   * Insert slot within `targetFiles`. `null` — the pointer was on the group
   * rather than on one of its rows (its header, or a collapsed group) — means
   * the end of the group.
   */
  toPosition: number | null
}

/**
 * What a cross-group move writes, or why it is refused.
 *
 * Moving a file to its own group is not this function's job (that is
 * `planFileMove`); callers resolve the drop first and only come here when the
 * groups differ.
 */
export function planFileRegroup({
  file,
  targetGroup,
  targetFiles,
  toPosition,
}: FileRegroupRequest): FileRegroupPlan {
  const corpusMarker = sameGroup(targetGroup, UNGROUPED_GROUP) ? null : targetGroup
  const landsIn = groupLabelForMarker(file, corpusMarker)
  if (!sameGroup(landsIn, targetGroup)) {
    return { ok: false, reason: "derived-group", targetGroup, landsIn }
  }
  return {
    ok: true,
    corpusMarker,
    writes: planFileInsert(targetFiles, file, toPosition ?? targetFiles.length),
  }
}
