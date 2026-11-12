// AQU-1902: the one answer to "which lane row does this target write address?"
//
// A target write (target.cell.* / cell.validate / cell.unvalidate) names its
// lane by `targetLang` (the lane's frozen `legacy_tag`) and, since AQU-1612, by
// `laneId`. An omitted lane used to mean "the default lane". Projects created
// today have no default lane — every target lane carries a real tag — so a
// lane-less write addresses nothing: the server refuses it (AQU-1900 422, a
// 500 "DB batch failed" before that), and the outbox drops it. That is a lost
// edit, so the client resolves the lane BEFORE the write is queued:
//
//  - lane rows known, `laneId` given → that row (its tag is stamped from the
//    row, so the two forms can never disagree).
//  - lane rows known, tag given      → the row whose `legacyTag` is exactly
//    that tag (`''` matches only a legacy default lane row).
//  - the project has NO target lane  → lane-less is correct: the server mints
//    the `''` bridge in the write's own batch (AQU-1594 / AQU-1615).
//  - anything else                   → unresolved. The caller must not queue
//    the write; it would be refused and lost.
//
// Pure on purpose: events-emit applies it to every lane-addressed event, the
// editor uses it to decide whether it may write at all.

/** The fields of a target lane row this resolution needs. */
export interface TargetLaneRow {
  id: string
  legacyTag: string | null
}

/** The lane a target write is stamped with. `laneId` is null only on a project
 *  with no target lane row at all, where the write mints the bridge itself. */
export interface TargetLaneRef {
  targetLang: string
  laneId: string | null
}

export type TargetLaneUnresolved =
  /** The project's lane rows have not loaded yet. */
  | "lanes-loading"
  /** The rows are known and none is the lane the write names. */
  | "no-such-lane"

export type TargetLaneResolution =
  | { ok: true; lane: TargetLaneRef }
  | { ok: false; reason: TargetLaneUnresolved }

/** What a writer asked for, as it would ride on the payload. */
export interface TargetLaneAsk {
  targetLang?: string | null
  laneId?: string | null
}

/**
 * Resolve a write's lane against the project's target lane rows.
 *
 * `rows` null means the rows are not known yet. An explicit `laneId` is still
 * honoured then — the server resolves and checks it — because a writer that
 * holds an id read it off a lane row. So is `hint`: the lane this tab last
 * resolved for the project (the persisted lane choice, an id read off a real
 * row), used only when it carries exactly the tag the write names — the lane
 * the editor is showing. Anything else waits for the rows.
 */
export function resolveTargetLaneRef(
  rows: readonly TargetLaneRow[] | null,
  ask: TargetLaneAsk,
  hint: { laneId: string; targetLang: string } | null = null,
): TargetLaneResolution {
  const laneId = ask.laneId ? ask.laneId : null
  const tag = ask.targetLang ?? ""
  if (rows === null) {
    if (laneId !== null) return { ok: true, lane: { targetLang: tag, laneId } }
    if (hint && hint.targetLang === tag) {
      return { ok: true, lane: { targetLang: tag, laneId: hint.laneId } }
    }
    return { ok: false, reason: "lanes-loading" }
  }
  if (laneId !== null) {
    const row = rows.find((lane) => lane.id === laneId)
    return row
      ? { ok: true, lane: { targetLang: row.legacyTag ?? "", laneId: row.id } }
      : { ok: false, reason: "no-such-lane" }
  }
  if (rows.length === 0) {
    return tag === ""
      ? { ok: true, lane: { targetLang: "", laneId: null } }
      : { ok: false, reason: "no-such-lane" }
  }
  const row = rows.find((lane) => (lane.legacyTag ?? "") === tag)
  return row
    ? { ok: true, lane: { targetLang: tag, laneId: row.id } }
    : { ok: false, reason: "no-such-lane" }
}

/** The payload fields for a resolved lane. `''` is omitted, as it always was. */
export function targetLanePayload(lane: TargetLaneRef): { targetLang?: string; laneId?: string } {
  return {
    ...(lane.targetLang ? { targetLang: lane.targetLang } : {}),
    ...(lane.laneId ? { laneId: lane.laneId } : {}),
  }
}
