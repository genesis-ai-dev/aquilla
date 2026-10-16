// Resolve a rendering list to one target lane.
//
// The rule lives in src/lib/terminology/rendering-lane.ts. This file only
// looks up the two lane ids: the permanent `legacy_tag === ''` bridge, and
// the lane the caller asked about. No `''` row yet means "do not filter"
// (the project has not grown lanes). A tag that names no row means no
// renderings — an unknown lane must not inherit the unstamped ones.

import { resolveLane } from "../../../db/shared/lane-ref"
import { renderingsForLane } from "../../../src/lib/terminology/rendering-lane"

export interface RenderingLaneScope {
  /** Null when the project has no `legacy_tag === ''` target lane. */
  emptyId: string | null
  /** Null when the requested tag names no target lane. */
  activeId: string | null
}

export async function renderingLaneScope(
  db: AquillaDb,
  projectId: string,
  laneTag: string,
): Promise<RenderingLaneScope> {
  const empty = await resolveLane(db, projectId, { targetLang: "" })
  if (!empty.laneId) return { emptyId: null, activeId: null }
  const active = await resolveLane(db, projectId, { targetLang: laneTag })
  return { emptyId: empty.laneId, activeId: active.laneId }
}

export function applyRenderingLaneScope<T>(
  renderings: readonly T[],
  scope: RenderingLaneScope,
): T[] {
  if (!scope.emptyId) return renderings.slice()
  if (!scope.activeId) return []
  return renderingsForLane(renderings, scope.activeId, scope.emptyId)
}
