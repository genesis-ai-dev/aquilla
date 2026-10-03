import { sameLanguageTag } from "../language-normalize"

/**
 * AQU-1473: project create stores the primary language in `targetLanes` as well
 * as `targetLanguage`. The primary is the default lane (`legacy_tag ''`), not
 * an additional lane. Readers that list the default lane beside this registry
 * must drop the primary or a new project shows its first language twice.
 *
 * `sameLanguageTag` (AQU-1597) keeps the region in the comparison: plain
 * `languagesEqual` strips it, so "fr-CA" and "French" both normalize to "fra".
 * A regional lane in a project whose primary is the base language is a real
 * extra lane and must stay listed.
 */
export function isPrimaryRegistryLane(
  tag: string,
  targetLanguage: string | null | undefined,
): boolean {
  const lane = tag.trim()
  if (!lane) return false
  return sameLanguageTag(lane, targetLanguage)
}

/** Registry tags that are real extra lanes, in their original order. */
export function extraRegistryLanes(
  targetLanes: readonly string[] | null | undefined,
  targetLanguage: string | null | undefined,
): string[] {
  return (targetLanes ?? []).filter((lane) => {
    const trimmed = lane.trim()
    return trimmed.length > 0 && !isPrimaryRegistryLane(trimmed, targetLanguage)
  })
}

/**
 * AQU-1532: the lane tag a write should carry. The primary language is the
 * default lane (`legacy_tag ''`), so a lane id that names it ("bla" or "BLA"
 * when `targetLanguage` is "bla") resolves to `''`. A regional lane beside the
 * primary ("fr-CA" next to "French") keeps its own tag. `undefined` stays
 * `undefined`, so a caller can still tell "no lane named" from "default lane".
 */
export function canonicalLaneId(laneId: string, targetLanguage: string | null | undefined): string
export function canonicalLaneId(
  laneId: string | undefined,
  targetLanguage: string | null | undefined,
): string | undefined
export function canonicalLaneId(
  laneId: string | undefined,
  targetLanguage: string | null | undefined,
): string | undefined {
  if (laneId === undefined) return undefined
  return isPrimaryRegistryLane(laneId, targetLanguage) ? "" : laneId
}
