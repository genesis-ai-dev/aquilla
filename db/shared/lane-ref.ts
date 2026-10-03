// AQU-1610: naming a lane in the contextual pipeline.
//
// A lane's identity is `lanes.id` (AQU-1420). `target_lang` is the LEGACY TAG
// that identity used to be spelled with, and it is still what older callers
// send and what the un-dropped projection columns store (AQU-1611 drops them).
//
// The tag is not an identity: two lanes agree on it whenever one was retagged
// after its rows were written, and `planNewTargetLane` hands a second lane of
// the same language its own lane id AS its tag — so a tag-keyed uniqueness
// rule lets one lane's active run, live draft, or approved brief occupy the
// slot that belongs to another lane. Everything here therefore keys on
// `lane_id`, and the tag survives only as the way in: a caller may send either,
// and the tag is resolved to an id once, at the edge of the store.
//
// db/shared cannot import sync-worker's lane-id-sql (different package), so
// the resolution is spelled out here. It is the same rule:
// (project_id, role='target', legacy_tag) → lanes.id.

import type { AquillaDb } from "../shim/postgres"

/**
 * How a caller names a lane. `laneId` wins when both are present — a client
 * that knows the id is never second-guessed by a tag that may name a
 * different lane.
 */
export interface LaneRef {
  /** `lanes.id` — the lane's real identity. */
  laneId?: string | null
  /** Legacy tag (`lanes.legacy_tag`, the old `target_lang` value). */
  targetLang?: string | null
}

/** A lane resolved to both spellings: the id every query keys on, and the tag
 *  the un-dropped `target_lang` columns still store. */
export interface ResolvedLane {
  /**
   * `null` when the ref named a lane that does not exist (yet). Filters then
   * match no row — "nothing in that lane" rather than borrowing another
   * lane's rows — and inserts leave `lane_id` to be filled the way the
   * pre-AQU-1610 scalar subquery left it.
   */
  laneId: string | null
  /** Never null: the `target_lang` columns are NOT NULL DEFAULT ''. */
  targetLang: string
}

/** Resolve a {@link LaneRef} against the project's lanes. One round trip. */
export async function resolveLane(
  db: AquillaDb,
  projectId: string,
  ref: LaneRef | undefined,
): Promise<ResolvedLane> {
  const laneId = (ref?.laneId ?? "").trim()
  if (laneId) {
    const row = await db
      .prepare("SELECT legacy_tag FROM lanes WHERE project_id = ? AND id = ?")
      .bind(projectId, laneId)
      .first<{ legacy_tag: string | null }>()
    // An id naming no lane stays the caller's id: reads match nothing and a
    // write fails its foreign key, both louder than silently widening to
    // another lane.
    return { laneId, targetLang: row?.legacy_tag ?? ref?.targetLang ?? "" }
  }
  const tag = ref?.targetLang ?? ""
  const row = await db
    .prepare("SELECT id FROM lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ?")
    .bind(projectId, tag)
    .first<{ id: string }>()
  return { laneId: row?.id ?? null, targetLang: tag }
}

/**
 * Normalize a positional lane argument. A bare string is the LEGACY TAG — the
 * spelling every pre-AQU-1610 caller passes — so existing call sites keep
 * their meaning while new ones pass `{ laneId }`.
 */
export function laneRef(lane: LaneRef | string | undefined): LaneRef {
  return typeof lane === "string" ? { targetLang: lane } : (lane ?? {})
}

/**
 * Resolve a value that may be EITHER a lane id or a legacy tag.
 *
 * For the two boundaries whose field is already called `laneId` but still
 * carries a tag (the external `DraftCells.laneId` and the copilot's
 * `context.lane`): an exact lane-id match wins, a tag match is the fallback.
 * Both readings work before and after AQU-1615 redefines that field, which is
 * what the lane batch's "earlier PRs must work before and after" rule asks
 * for. Lane ids are 8 hex characters, so a tag can only shadow one by being
 * that lane's id — which is the case `planNewTargetLane` creates, and there
 * the id reading is the right one anyway.
 */
export async function resolveLaneIdOrTag(
  db: AquillaDb,
  projectId: string,
  value: string | null | undefined,
): Promise<ResolvedLane> {
  const v = (value ?? "").trim()
  const row = await db
    .prepare(
      `SELECT id, legacy_tag FROM lanes
        WHERE project_id = ? AND role = 'target' AND (id = ? OR legacy_tag = ?)
        ORDER BY (id = ?) DESC
        LIMIT 1`,
    )
    .bind(projectId, v, v, v)
    .first<{ id: string; legacy_tag: string | null }>()
  return row
    ? { laneId: row.id, targetLang: row.legacy_tag ?? "" }
    : { laneId: null, targetLang: v }
}

/**
 * A {@link LaneRef} where naming the lane is NOT optional: one spelling or the
 * other must be present. Readers that pair a source row with a target row use
 * this, so no caller can leave the lane out and silently pair one lane's
 * source cells with every lane's targets.
 */
export type RequiredLaneRef =
  | { laneId: string | null; targetLang?: string | null }
  | { laneId?: string | null; targetLang: string }
