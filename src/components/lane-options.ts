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
 *
 * AQU-1784: that label is not necessarily unique. Two lanes of one language
 * with no name override, or two lanes named the same, resolve to the same
 * string and used to render as identical rows. The disambiguating suffix
 * (`src/lib/lanes/lane-label-suffix.ts`) is therefore applied HERE, over the
 * lanes this surface shows — which is also why the suffix never leaks a lane
 * a member cannot see: a filtered list has nothing to collide with.
 */

import { isLaneArchived } from "./project-lane-archive"
import { laneLabelSuffixes, withLaneLabelSuffix } from "@/lib/lanes/lane-label-suffix"
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
  /** AQU-1784: code OVERRIDES by tag (`laneCodesByTag`) — the preferred suffix
   *  for a lane whose label collides with another's. Derived codes are not
   *  passed: both colliding lanes derive the same one. */
  laneCodes?: Readonly<Record<string, string>>
}

/** A lane's label on this surface, with the collision suffix kept separate so
 *  a caller with its own base label (the editor's TARGET pill) can reuse it. */
export interface LaneOptionLabel {
  /** The lane tag. */
  value: string
  /** The label before disambiguation. */
  base: string
  /** The disambiguating suffix, or null when this label is already unique. */
  suffix: string | null
  /** `base` with `suffix` applied — what the surface shows. */
  label: string
  archived: boolean
}

/** Labels for lane tags, input order preserved, collisions told apart. */
export function laneOptionLabels({
  lanes,
  laneLabels,
  defaultLaneLabel,
  archivedLanes,
  laneCodes,
}: LaneOptionInputs): LaneOptionLabel[] {
  const bases = lanes.map((lane) => {
    // Trimmed, so an all-whitespace lane name falls through to the tag instead
    // of rendering a blank, unclickable-looking row.
    const named = laneLabels?.[lane]?.trim()
    return named || (lane === "" ? defaultLaneLabel : lane)
  })
  const suffixes = laneLabelSuffixes(
    bases.map((base, index) => ({ label: base, code: laneCodes?.[lanes[index]] })),
  )
  return lanes.map((lane, index) => ({
    value: lane,
    base: bases[index],
    suffix: suffixes[index],
    label: withLaneLabelSuffix(bases[index], suffixes[index]),
    archived: isLaneArchived(lane, archivedLanes),
  }))
}

/** Labels as `LaneCombobox` options — the tag is the e2e test id. */
export function toLaneComboboxOptions(
  labels: readonly LaneOptionLabel[],
): LaneComboboxOption[] {
  return labels.map(({ value, label, archived }) => ({
    value,
    label,
    archived,
    testId: value,
  }))
}

/** Lane tags as combobox options, input order preserved. */
export function laneComboboxOptions(inputs: LaneOptionInputs): LaneComboboxOption[] {
  return toLaneComboboxOptions(laneOptionLabels(inputs))
}
