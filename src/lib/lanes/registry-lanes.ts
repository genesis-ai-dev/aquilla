import { languagesEqual } from "../language-normalize"

/**
 * AQU-1473: project create stores the primary language in `targetLanes` as well
 * as `targetLanguage`. The primary is the default lane (`legacy_tag ''`), not
 * an additional lane. Readers that list the default lane beside this registry
 * must drop the primary or a new project shows its first language twice.
 */
export function isPrimaryRegistryLane(
  tag: string,
  targetLanguage: string | null | undefined,
): boolean {
  const lane = tag.trim()
  if (!lane) return false
  return languagesEqual(lane, targetLanguage)
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
