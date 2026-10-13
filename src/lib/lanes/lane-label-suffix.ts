/**
 * AQU-1784: two lanes that show the same string get told apart.
 *
 * A lane displays its `name`, or its `language` when it has no name
 * (`laneDisplayName`). Nothing stops two target lanes from resolving to the
 * same string — the same language with no name override on either, or the same
 * name typed twice — and when that happens every lane surface used to render
 * them as identical rows. Two people were both "on Tshangla" while reading
 * different lanes, with different cells and different progress, and the screen
 * said nothing: the 2026-10-08 Come and See report was undiagnosable for
 * exactly that reason.
 *
 * So a colliding lane carries a SUFFIX. The suffix is the lane's code when the
 * maintainer set one — that is the distinguishing thing they already typed —
 * and otherwise its position among the lanes it collides with. The lane in
 * first position keeps the bare label, so a project with one "Tshangla" reads
 * exactly as before and the second one reads "Tshangla · 2".
 *
 * Two rules make it trustworthy:
 *
 *   * **It is computed from the lanes the surface SHOWS.** A member below
 *     Maintainer sees only the lanes the read wall left them, so a lone
 *     visible lane never collides and never grows a suffix that would betray
 *     a sibling they may not see (AQU-1421).
 *   * **Position is the position in the caller's list**, which is registry
 *     order (`position`, then id). Reordering lanes that do not collide
 *     cannot renumber the ones that do, so a label does not change under the
 *     reader between one reload and the next.
 *
 * Only derived codes are useless here, which is why a DERIVED code is never
 * passed in: two lanes of one language derive the same one.
 */

/** Between a lane's label and its disambiguating suffix. */
export const LANE_LABEL_SUFFIX_SEPARATOR = " · "

export interface LaneLabelCandidate {
  /** The label this surface would show on its own, before disambiguation. */
  label: string
  /** The lane's code OVERRIDE, when it has one. Never a derived code. */
  code?: string | null
}

/** Case/whitespace-folded label — the identity two lanes collide on. */
function fold(label: string): string {
  return label.trim().toLocaleLowerCase()
}

/**
 * The suffix for each lane, in the caller's order; `null` where the lane's
 * label is already unique in this list and must render untouched.
 */
export function laneLabelSuffixes(
  lanes: readonly LaneLabelCandidate[],
): (string | null)[] {
  const groups = new Map<string, number[]>()
  for (const [index, lane] of lanes.entries()) {
    const key = fold(lane.label)
    const group = groups.get(key)
    if (group) group.push(index)
    else groups.set(key, [index])
  }

  const suffixes: (string | null)[] = lanes.map(() => null)
  for (const group of groups.values()) {
    if (group.length < 2) continue
    // The code the maintainer set, else the lane's place in the collision.
    const preferred = group.map((index, place) => {
      const code = lanes[index].code?.trim()
      return code || positionSuffix(place)
    })
    // A code only disambiguates while it is itself distinct: two lanes
    // carrying the same override would collide again, so the whole group
    // falls back to position rather than leaving one pair identical.
    const distinct = new Set(preferred.map((suffix) => fold(suffix ?? "")))
    const resolved =
      distinct.size === group.length ? preferred : group.map((_, place) => positionSuffix(place))
    for (const [place, index] of group.entries()) suffixes[index] = resolved[place]
  }
  return suffixes
}

/** First place keeps the bare label; the rest are numbered from 2. */
function positionSuffix(place: number): string | null {
  return place === 0 ? null : String(place + 1)
}

/** `label` with `suffix` appended, or `label` unchanged when there is none. */
export function withLaneLabelSuffix(label: string, suffix: string | null): string {
  return suffix ? `${label}${LANE_LABEL_SUFFIX_SEPARATOR}${suffix}` : label
}

/** The labels a surface shows, told apart where they would otherwise collide. */
export function disambiguatedLaneLabels(lanes: readonly LaneLabelCandidate[]): string[] {
  const suffixes = laneLabelSuffixes(lanes)
  return lanes.map((lane, index) => withLaneLabelSuffix(lane.label, suffixes[index]))
}
