/**
 * Which lane a rendering belongs to.
 *
 * Concepts and source terms stay project-level. A rendering carries `laneId`
 * (`lanes.id`). When that field is missing — every rendering written before
 * the lane stamp — it belongs to the project's target lane whose
 * `legacy_tag` is `''`. That row is the permanent bridge: events are never
 * rewritten, and readers use this function until the backfill (AQU-1616)
 * has re-folded the projection.
 *
 * Keep this module free of `@/` aliases. The fold and the workers import it.
 */

export interface RenderingLaneRef {
  id: string
  role?: "source" | "target"
  /** Exact `lanes.legacy_tag`. `null` is the source lane, not `''`. */
  legacyTag?: string | null
}

export interface RenderingWithLane {
  laneId?: string | null
}

/** The lane id a rendering is read as. A non-empty `laneId` wins. */
export function renderingLaneId(
  rendering: RenderingWithLane,
  legacyEmptyLaneId: string,
): string {
  const id = rendering.laneId
  if (typeof id === "string" && id !== "") return id
  return legacyEmptyLaneId
}

/** Stamp a missing lane id. A null bridge id leaves the rendering alone. */
export function stampRenderingLane<T>(
  rendering: T,
  legacyEmptyLaneId: string | null,
): T {
  const current = rendering as T & RenderingWithLane
  if (!legacyEmptyLaneId) return rendering
  if (typeof current.laneId === "string" && current.laneId !== "") return rendering
  return { ...current, laneId: legacyEmptyLaneId }
}

export function stampRenderingLanes<T>(
  renderings: readonly T[],
  legacyEmptyLaneId: string | null,
): T[] {
  if (!legacyEmptyLaneId) return renderings.slice()
  return renderings.map((rendering) => stampRenderingLane(rendering, legacyEmptyLaneId))
}

export function renderingsForLane<T>(
  renderings: readonly T[],
  laneId: string,
  legacyEmptyLaneId: string,
): T[] {
  return renderings.filter(
    (rendering) => renderingLaneId(rendering as RenderingWithLane, legacyEmptyLaneId) === laneId,
  )
}

export function conceptsForLane<T extends { renderings: readonly unknown[] }>(
  concepts: readonly T[],
  laneId: string,
  legacyEmptyLaneId: string,
): T[] {
  return concepts.map((concept) => ({
    ...concept,
    renderings: renderingsForLane(concept.renderings, laneId, legacyEmptyLaneId),
  }))
}

/**
 * Replace one lane's slice inside the stored list. Other lanes stay, in
 * their original order. The new slice is stamped with `laneId` and written
 * where that lane's renderings used to sit.
 */
export function replaceLaneRenderings<T>(
  all: readonly T[],
  laneId: string,
  legacyEmptyLaneId: string,
  nextSlice: readonly T[],
): T[] {
  const stamped = nextSlice.map((rendering) =>
    stampRenderingLane({ ...(rendering as T & RenderingWithLane), laneId }, legacyEmptyLaneId),
  )
  const out: T[] = []
  let placed = false
  for (const rendering of all) {
    if (renderingLaneId(rendering as RenderingWithLane, legacyEmptyLaneId) !== laneId) {
      out.push(rendering)
      continue
    }
    if (!placed) {
      out.push(...stamped)
      placed = true
    }
  }
  if (!placed) out.push(...stamped)
  return out
}

/** Id of the target lane whose `legacy_tag` is exactly `''`, or null. */
export function legacyEmptyLaneId(lanes: readonly RenderingLaneRef[]): string | null {
  return laneIdForLegacyTag("", lanes)
}

/** Exact `legacyTag` match. Source rows are skipped. `null` is not `''`. */
export function laneIdForLegacyTag(
  tag: string,
  lanes: readonly RenderingLaneRef[],
): string | null {
  const row = lanes.find((lane) => lane.role !== "source" && lane.legacyTag === tag)
  return row?.id ?? null
}

/**
 * Filter concepts to the lane named by a legacy tag.
 *
 * No `''` row yet: return the list unchanged (a shallow copy). A tag that
 * names no row: empty renderings, so an unknown lane does not inherit the
 * unstamped ones.
 */
export function conceptsForLaneTag<T extends { renderings: readonly unknown[] }>(
  concepts: readonly T[],
  laneTag: string,
  lanes: readonly RenderingLaneRef[],
): T[] {
  const emptyId = legacyEmptyLaneId(lanes)
  if (!emptyId) return concepts.slice()
  const activeId = laneIdForLegacyTag(laneTag, lanes)
  if (!activeId) return concepts.map((concept) => ({ ...concept, renderings: [] }))
  return conceptsForLane(concepts, activeId, emptyId)
}
