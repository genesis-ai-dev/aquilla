/**
 * One place that turns a list of lane tags into `LaneCombobox` options
 * (AQU-1631).
 *
 * The editor's lane switcher owned this mapping inline, and the file-target
 * import's language picker needs exactly the same one: the row's name when it
 * has one, the tag otherwise, the caller's label for the default lane (`''`),
 * and the archived flag `LaneCombobox` hides behind its reveal row (AQU-601).
 * Two copies would be two chances for a surface to label a lane differently
 * from the one the user just switched away from, so both surfaces call this.
 */

import { isLaneArchived } from "./project-lane-archive"
import type { LaneComboboxOption } from "./LaneCombobox"

export interface LaneOptionInputs {
  /** Lane tags in registry order; `''` is the default lane. */
  lanes: readonly string[]
  /** Lane-row names by tag. A blank/absent name falls through to the tag. */
  laneLabels?: Readonly<Record<string, string>>
  /** Label for the default lane (`''`) when no lane row names it. */
  defaultLaneLabel: string
  /** Tags of archived lanes (AQU-601). */
  archivedLanes?: readonly string[]
}

/** Lane tags as combobox options, input order preserved. */
export function laneComboboxOptions({
  lanes,
  laneLabels,
  defaultLaneLabel,
  archivedLanes,
}: LaneOptionInputs): LaneComboboxOption[] {
  return lanes.map((lane) => {
    // Trimmed, so an all-whitespace lane name falls through to the tag instead
    // of rendering a blank, unclickable-looking row.
    const named = laneLabels?.[lane]?.trim()
    return {
      value: lane,
      label: named || (lane === "" ? defaultLaneLabel : lane),
      archived: isLaneArchived(lane, archivedLanes),
      testId: lane,
    }
  })
}
