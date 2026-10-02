import { languagesEqual } from "../language-normalize"

/** Subtags after the language: "fr-CA" → "ca"; a bare name or code has none. */
function subtags(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/).slice(1).join("-")
}

/**
 * AQU-1473: project create stores the primary language in `targetLanes` as well
 * as `targetLanguage`. The primary is the default lane (`legacy_tag ''`), not
 * an additional lane. Readers that list the default lane beside this registry
 * must drop the primary or a new project shows its first language twice.
 *
 * `languagesEqual` alone is not enough: it strips the region, so "fr-CA" and
 * "French" both normalize to "fra". A regional lane in a project whose primary
 * is the base language is a real extra lane and must stay listed.
 */
export function isPrimaryRegistryLane(
  tag: string,
  targetLanguage: string | null | undefined,
): boolean {
  const lane = tag.trim()
  if (!lane) return false
  return languagesEqual(lane, targetLanguage) && subtags(lane) === subtags(targetLanguage ?? "")
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
