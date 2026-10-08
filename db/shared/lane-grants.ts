// AQU-1781 — creating a target lane has to grant it to the people who already
// read every lane.
//
// Under the lane read wall a member below Maintainer reads only the lanes they
// hold a `project_member_lane_roles` row for. Two paths wrote those rows:
// accepting an invite (every lane that existed at that moment) and a lead
// saving a member's scopes. Lane creation wrote none, so every lane added after
// a member joined was invisible to them while the member inspector still called
// them "Unscoped — full access".
//
// The rule here is the one `planLaneGrants` already encodes, expressed as SQL so
// it can ride in the same batch as the lane insert:
//   * a member who reads every lane the project already had reads every lane as
//     a standing fact, so the new lane is granted at their project role level
//   * a member limited to some of the lanes keeps only those — a lane created
//     later is not one of them, so no row
//   * Maintainer (600) and above are above the wall, and below Viewer (100) has
//     no read at all: neither gets a row
//
// "Reads every lane" is read off the grant rows, not off `project_member_scopes`:
// per 0091 the leveled grant model REPLACED that table's kind='lane' rows, so a
// member staffed onto one lane can hold a single grant and no scope row at all
// (that is what the AQU-730 backfill and the member inspector produce). Asking
// only "has no lane scope" would hand such a member every lane added afterwards,
// silently widening access a lead had deliberately narrowed. So the test is: do
// they already hold a grant for every OTHER target lane of this project? The
// legacy scope rows are still consulted as well, so a member narrowed only on
// the old table is excluded too.
//
// A project with no other target lane satisfies that vacuously, which is the
// bare-project case: nobody can hold a grant for a lane that does not exist, and
// the bridge the first translation creates must be readable by the members who
// are already there.
//
// Keyed by the lane's id OR its legacy tag, because the tag-keyed writers
// (`ensureProjectLaneStmts`, `ensureTargetLaneStmt`, `ensureBlankTargetBridgeStmt`)
// upsert and may not own the row the batch ends up with. Either way the join
// grants exactly the one lane named and nothing else, so an archived lane
// elsewhere in the project is never picked up as a side effect. The insert is
// `ON CONFLICT DO NOTHING`, so a lane created twice (or a creation path that
// no-ops) writes no duplicate rows.
//
// Lives in db/shared so auth-worker and sync-worker apply the SAME write.

import type { AquillaDb, AquillaStatement } from "../shim/postgres"

/** `planLaneGrants`' ceiling: Maintainer and above see every lane by role. */
const GRANT_BELOW_ROLE = 600
/** `planLaneGrants`' floor: below Viewer reads nothing, granted or not. */
const GRANT_MIN_ROLE = 100

/** The lane just created, by id when the caller owns it, else by legacy tag. */
export type NewLaneRef = { laneId: string; legacyTag?: undefined } | { legacyTag: string; laneId?: undefined }

function laneKeyColumn(ref: NewLaneRef): { column: string; value: string } {
  return ref.laneId === undefined
    ? { column: "legacy_tag", value: ref.legacyTag }
    : { column: "id", value: ref.laneId }
}

/**
 * Grant one newly created target lane to every member below Maintainer who
 * already reads every other lane of the project. Safe to splice into the batch
 * that creates the lane — it reads the lane back out of `lanes`, so a creation
 * that rolled back or no-opped grants nothing.
 */
export function grantNewLaneStmt(
  db: AquillaDb,
  projectId: string,
  ref: NewLaneRef,
  grantedBy: number | null,
): AquillaStatement {
  const key = laneKeyColumn(ref)
  return db
    .prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       SELECT m.project_id, m.user_id, l.id, m.role_level, ?
         FROM project_members m
         JOIN lanes l
           ON l.project_id = m.project_id
          AND l.role = 'target'
          AND l.${key.column} = ?
        WHERE m.project_id = ?
          AND m.role_level >= ${GRANT_MIN_ROLE}
          AND m.role_level < ${GRANT_BELOW_ROLE}
          AND NOT EXISTS (
            SELECT 1 FROM project_member_scopes s
             WHERE s.project_id = m.project_id
               AND s.user_id = m.user_id
               AND s.kind = 'lane'
          )
          AND NOT EXISTS (
            SELECT 1 FROM lanes other
             WHERE other.project_id = m.project_id
               AND other.role = 'target'
               AND other.id <> l.id
               AND NOT EXISTS (
                 SELECT 1 FROM project_member_lane_roles g
                  WHERE g.project_id = m.project_id
                    AND g.user_id = m.user_id
                    AND g.lane = other.id
               )
          )
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    .bind(grantedBy, key.value, projectId)
}

/** {@link grantNewLaneStmt} for a caller that writes outside a batch. */
export async function grantNewLane(
  db: AquillaDb,
  projectId: string,
  ref: NewLaneRef,
  grantedBy: number | null,
): Promise<void> {
  await grantNewLaneStmt(db, projectId, ref, grantedBy).run()
}
