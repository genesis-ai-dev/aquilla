// AQU-1532: a lane id that names the project's primary target language is the
// default lane (`legacy_tag ''`), which has no row of its own under that name.
// Prepare and commit both run lane ids through here so the projection never
// looks up a lane row that does not exist (NULL lane_id → 500).

import { canonicalLaneId } from '../../../src/lib/lanes/registry-lanes'

export { canonicalLaneId }

/** `settings.targetLanguage`, or null when unset or not a string. */
export function settingsTargetLanguage(settings: Record<string, unknown>): string | null {
  return typeof settings.targetLanguage === 'string' ? settings.targetLanguage : null
}

/**
 * The item with its `laneId` made canonical. A lane id naming the primary is
 * dropped, because an absent `laneId` is how SetTranslation and DraftCells
 * address the default lane.
 */
export function withCanonicalLaneId<T extends { laneId?: string }>(
  item: T,
  targetLanguage: string | null,
): T {
  if (item.laneId === undefined || canonicalLaneId(item.laneId, targetLanguage) !== '') return item
  const copy = { ...item }
  delete copy.laneId
  return copy
}
