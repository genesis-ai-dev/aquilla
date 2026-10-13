/**
 * Tags the lane switcher offers.
 *
 * Lane rows are the list. A blank tag is included only when a row's
 * `legacy_tag` is `''`. Inventing one beside a tagged target shows that
 * language twice: the blank entry is still labeled from the project language
 * (AQU-1776). With no rows yet, `fallbackWhenNoRows` is returned unchanged so
 * a project that predates lane rows still has the list its caller built.
 */
export interface SwitcherLaneRow {
  id: string
  position: number
  legacyTag: string | null
}

export function switcherLaneTags(
  laneRows: readonly SwitcherLaneRow[],
  fallbackWhenNoRows: readonly string[],
): string[] {
  if (laneRows.length === 0) return [...fallbackWhenNoRows]
  const tags = [...laneRows]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((lane) => lane.legacyTag ?? "")
  return [...new Set(tags)]
}
