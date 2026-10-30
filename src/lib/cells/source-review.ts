// Cells whose source text changed in a sidebar re-import. The flag lives on
// the source row as `metadata.aquillaImport.reviewLanes` (lane row ids) and
// clears when that lane is validated.

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Lane ids still waiting for someone to review a re-imported source change. */
export function sourceReviewLanes(metadata: unknown): string[] {
  const aquilla = objectRecord(objectRecord(metadata)?.aquillaImport)
  const lanes = aquilla?.reviewLanes
  if (!Array.isArray(lanes)) return []
  return lanes.filter((lane): lane is string => typeof lane === "string" && lane.length > 0)
}

/** True when the open lane is one this re-import asked the translator to review. */
export function cellNeedsSourceReview(metadata: unknown, laneId: string | null | undefined): boolean {
  if (!laneId) return false
  return sourceReviewLanes(metadata).includes(laneId)
}
