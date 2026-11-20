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
// `ON CONFLICT DO NOTHING`, so a lane created twice writes no duplicate rows.
//
// AQU-2557: the grant is for a lane the write CREATES. The tag-keyed writers
// run on every write to their lane, not only the one that makes it: each
// default-language commit, each import into the default lane, each Codex
// re-ingest. And "holds every OTHER lane" leaves out the lane being granted,
// so on a lane that already exists it is true of a member a lead narrowed AWAY
// from that lane, and the rule handed them the lane they had been kept out of.
// So the lane is granted only when its row was inserted in the current
// transaction: `created_at` defaults to now(), which is the transaction's start
// time, and an upsert that finds the row leaves it alone. One rule for both
// keys: the statement rides the same batch as the lane insert, which every
// writer does (Project settings' new language included, inside
// `insertTargetLane`), so the lane and the grants that make it readable commit
// together or not at all.
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
 * already reads every other lane of the project. Splice it into the batch that
 * creates the lane — it reads the lane back out of `lanes`, so a creation that
 * rolled back or no-opped grants nothing, and a lane that was already there
 * when the batch began is not new and is granted to nobody (AQU-2557).
 *
 * AQU-1800: "every member" is {@link projectWallMembersSql} — the team path as
 * well as `project_members`. A project a team reaches and nobody joined
 * directly used to grant its new lanes to nobody at all, which is what a
 * freshly migrated Codex project looks like: attached to its GitLab team, its
 * lanes created afterwards by the content sweep.
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
       SELECT ?, m.user_id, l.id, m.role_level, ?
         FROM (${projectWallMembersSql()}) m
         JOIN lanes l
           ON l.project_id = ?
          AND l.role = 'target'
          AND l.${key.column} = ?
          AND l.created_at = transaction_timestamp()
        WHERE m.role_level >= ${GRANT_MIN_ROLE}
          AND m.role_level < ${GRANT_BELOW_ROLE}
          AND NOT EXISTS (
            SELECT 1 FROM project_member_scopes s
             WHERE s.project_id = ?
               AND s.user_id = m.user_id
               AND s.kind = 'lane'
          )
          AND NOT EXISTS (
            SELECT 1 FROM lanes other
             WHERE other.project_id = ?
               AND other.role = 'target'
               AND other.id <> l.id
               AND NOT EXISTS (
                 SELECT 1 FROM project_member_lane_roles g
                  WHERE g.project_id = ?
                    AND g.user_id = m.user_id
                    AND g.lane = other.id
               )
          )
          AND (EXISTS (SELECT 1 FROM project_members pm
                        WHERE pm.project_id = l.project_id
                          AND pm.user_id = m.user_id)
               OR ${memberTeamAttachmentSql("m.user_id", "l.project_id", attachmentCoversLaneSql("ga", "l.id"))})
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    // AQU-2563: the last condition keeps out a member whose only path here is
    // a team a lead limited to other lanes (see `attachmentCoversLaneSql`).
    // It reads the project through `l`, so it adds no placeholder.
    // Nine placeholders, in textual order: the row's project id, grantedBy,
    // the two the member source takes, the lane join's project id, the lane
    // key, and the three sub-selects' project ids.
    .bind(
      projectId,
      grantedBy,
      projectId,
      projectId,
      projectId,
      key.value,
      projectId,
      projectId,
      projectId,
    )
}


// ---------------------------------------------------------------------------
// AQU-1800 — the team path has to write lane grants too.
//
// Project access arrives by two paths: a direct `project_members` row, and a
// team attached to the project through `group_project_grants`. Every lane-grant
// writer before this ticket knew only the first one:
//
//   - invite accept / staffing / direct add  → services/lane-grants.ts, keyed
//     on `project_members`
//   - lane creation                          → `grantNewLaneStmt` above, also
//     keyed on `project_members`
//
// So nobody who reached a project through a team ever held a grant, and under
// the wall they opened the project to source text only. The nightly Codex sync
// is how most of them arrive — it adds the members of each GitLab subgroup to
// the matching team and attaches each migrated project to its team at
// Contributor — which is why this reads as "assigned in git, worked in
// Aquilla, can't edit".
//
// Two writes close it, and both are below:
//
//   1. `projectWallMembersSql` makes `grantNewLaneStmt` see the team path, so a
//      lane created on a project a team reaches is granted to that team's
//      members on the same terms as a direct member's. That is the half of the
//      bug a newly migrated project hits: its lanes are created by the content
//      sweep, AFTER the project was attached to its team.
//   2. `grantTeamLaneAccessStmt` seeds the lanes a project ALREADY has when
//      someone joins the team or the team is attached to the project. Lane
//      creation cannot do that one: the lanes predate the membership.

/**
 * Every member the wall governs on one project, at the highest role level that
 * reaches them, from both access paths. Mirrors the `team` and `direct` project
 * rows of the `access_grants` view (db/shared/access-grants.ts): a team's role
 * on the project, raised by the member's own team-scope role when they hold one
 * (`group_members.role_level`, NULL for a legacy member), and max-wins against
 * a direct `project_members` row.
 *
 * Deliberately NOT the full `resolveFromGrants`: the org path, the creator and
 * the platform admin are all Maintainer-or-above cases, and a grant row for
 * someone the wall already waves through changes nothing (`visibleLaneTags`
 * returns "every lane" at 600+). Grants only ever elevate — effective role in a
 * lane is `max(base project role, grant role_level)` per migration 0091 — so a
 * row at the team's role can never cost a member access their base role gives
 * them.
 *
 * Takes the project id TWICE, in textual placeholder order.
 */
export function projectWallMembersSql(): string {
  return `SELECT x.user_id AS user_id, MAX(x.role_level) AS role_level
            FROM (SELECT pm.user_id, pm.role_level
                    FROM project_members pm
                   WHERE pm.project_id = ?
                  UNION ALL
                  SELECT gm.user_id, GREATEST(gpg.role_level, COALESCE(gm.role_level, 0))
                    FROM group_project_grants gpg
                    JOIN group_members gm ON gm.group_id = gpg.group_id
                   WHERE gpg.project_id = ?) x
           GROUP BY x.user_id`
}

// AQU-2563 — a team attachment a lead limited to chosen lanes (AQU-1813:
// `lanes_explicit` + `group_project_lanes`) reaches only those lanes, for the
// people already on the team and for the people added later alike. The
// auth-worker paths read it per person (`teamLaneAccess`): any living
// attachment that brings the person to the project means every lane, otherwise
// the union of the lanes the limited attachments list. The two helpers below
// are that rule as SQL, so the sync's team seeding and lane creation follow it
// too. A living attachment (`lanes_explicit = false`) covers every lane, which
// is what both statements did for every attachment before.

/** Does attachment row `gpg` (a `group_project_grants` alias) cover lane `lane`? */
function attachmentCoversLaneSql(gpg: string, lane: string): string {
  return `(NOT ${gpg}.lanes_explicit
           OR EXISTS (SELECT 1 FROM group_project_lanes gpl
                       WHERE gpl.group_id = ${gpg}.group_id
                         AND gpl.project_id = ${gpg}.project_id
                         AND gpl.lane_id = ${lane}))`
}

/**
 * Is `user` on a team attached to `project` whose attachment row (alias `ga`)
 * satisfies `condition`? Reads the stored `group_members`, so a dry run's
 * pending member is seen only through the attachment being seeded.
 */
function memberTeamAttachmentSql(user: string, project: string, condition: string): string {
  return `EXISTS (SELECT 1 FROM group_project_grants ga
                    JOIN group_members gma ON gma.group_id = ga.group_id
                   WHERE ga.project_id = ${project}
                     AND gma.user_id = ${user}
                     AND ${condition})`
}

/** The member source of {@link grantTeamLaneAccessStmt}, as SQL. */
function teamMembersSql(pending: boolean): string {
  if (!pending) {
    return `SELECT gm0.user_id AS user_id, gm0.role_level AS role_level
              FROM group_members gm0
             WHERE gm0.group_id = ?`
  }
  // Dry run: the people the apply is about to add are not on the team yet, so
  // the planned ids join the stored rows. A planned id that is already a member
  // is dropped rather than unioned in at role_level NULL, which would double
  // count them and understate their level.
  return `SELECT gm0.user_id AS user_id, gm0.role_level AS role_level
            FROM group_members gm0
           WHERE gm0.group_id = ?
          UNION ALL
          SELECT x.v::BIGINT, NULL::INTEGER
            FROM jsonb_array_elements_text(?::jsonb) AS x(v)
           WHERE NOT EXISTS (SELECT 1 FROM group_members gm1
                              WHERE gm1.group_id = ? AND gm1.user_id = x.v::BIGINT)`
}

/**
 * The rows "every current target lane of every project this team is attached
 * to, for the team members the wall governs who hold no lane access there yet".
 *
 * Only a member with NO grant row on the project is seeded, which is the rule
 * `applyDirectAddLaneGrants` already follows: some grants means a lead narrowed
 * them deliberately, and widening that silently is the regression AQU-1781
 * guards against. A `kind='lane'` scope row says the same thing on the legacy
 * table. Together those two make the write idempotent — the second run finds
 * the rows it wrote and selects nothing.
 *
 * Archived lanes are granted too, exactly as `applyDirectAddLaneGrants` does.
 * They reveal nothing on their own — an archived lane is not one of the lanes a
 * project shows — but AQU-1781 gives a newly created lane only to a member who
 * already reads every OTHER target lane, archived ones included. Seeding only
 * the current lanes would therefore leave a team member silently skipping every
 * lane the project adds later, which is the AQU-1783 gap. This is a deliberate
 * deviation from AQU-1800's "archived lanes are never granted": the spec's
 * *Admission writes the whole of a member's access* says archived included, and
 * the two halves have to agree or the team path drifts from the direct one.
 *
 * AQU-2563: "every lane" is every lane the member's attachments cover — this
 * one, or another team that brings them to the same project, so the order the
 * sync runs its teams in does not decide what a member of two teams gets. A
 * limited attachment with nothing checked covers nothing. `scoped` marks the
 * rows whose lane set is a limit (no living attachment brings the member here)
 * and who have no direct membership: those also get a kind='lane' scope row,
 * which is what `replaceLaneRows` leaves them with on the auth-worker side.
 * A direct member's scope rows belong to the direct membership, and the
 * auth-worker leaves them alone too (`unionTeamLanesIntoDirect`).
 */
function teamLaneGrantBodySql(pending: boolean): string {
  return `SELECT gpg.project_id AS project_id,
                 gm.user_id     AS user_id,
                 l.id           AS lane,
                 GREATEST(gpg.role_level, COALESCE(gm.role_level, 0)) AS role_level,
                 (gpg.lanes_explicit
                  AND NOT ${memberTeamAttachmentSql("gm.user_id", "gpg.project_id", "NOT ga.lanes_explicit")}
                  AND NOT EXISTS (SELECT 1 FROM project_members pm
                                   WHERE pm.project_id = gpg.project_id
                                     AND pm.user_id = gm.user_id)) AS scoped
            FROM (${teamMembersSql(pending)}) gm
            JOIN group_project_grants gpg ON gpg.group_id = ?
            JOIN lanes l ON l.project_id = gpg.project_id
                        AND l.role = 'target'
           WHERE (${attachmentCoversLaneSql("gpg", "l.id")}
                  OR ${memberTeamAttachmentSql("gm.user_id", "gpg.project_id", attachmentCoversLaneSql("ga", "l.id"))})
             AND GREATEST(gpg.role_level, COALESCE(gm.role_level, 0)) >= ${GRANT_MIN_ROLE}
             AND GREATEST(gpg.role_level, COALESCE(gm.role_level, 0)) < ${GRANT_BELOW_ROLE}
             AND NOT EXISTS (SELECT 1 FROM project_member_lane_roles g
                              WHERE g.project_id = gpg.project_id
                                AND g.user_id = gm.user_id)
             AND NOT EXISTS (SELECT 1 FROM project_member_scopes s
                              WHERE s.project_id = gpg.project_id
                                AND s.user_id = gm.user_id
                                AND s.kind = 'lane')`
}

/**
 * Give one team's members lane access on the projects it is attached to. Safe
 * to splice into the batch that adds the member or attaches the project — it
 * reads `group_members` / `group_project_grants` / `lanes` back out, so it sees
 * whatever the earlier statements in the same transaction wrote and grants
 * nothing when they rolled back.
 */
export function grantTeamLaneAccessStmt(
  db: AquillaDb,
  teamId: number | string,
  grantedBy: number | null,
): AquillaStatement {
  // One statement, so the scope rows and the grants are both chosen from the
  // state before either is written: the body's "holds no grant and no scope
  // row yet" test would otherwise see the other half and select nothing.
  return db
    .prepare(
      `WITH src AS (${teamLaneGrantBodySql(false)}),
            scopes AS (
              INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
              SELECT src.project_id, src.user_id, 'lane', src.lane, ?::TEXT, ?
                FROM src
               WHERE src.scoped
              ON CONFLICT (project_id, user_id, kind, value) DO NOTHING
            )
       INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       SELECT src.project_id, src.user_id, src.lane, src.role_level, ?
         FROM src
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    .bind(teamId, teamId, grantedBy == null ? "0" : String(grantedBy), Date.now(), grantedBy)
}

/**
 * How many rows {@link grantTeamLaneAccessStmt} would add once `pendingUserIds`
 * are on the team — what the sync's dry run reports before it writes anything.
 * Read-only.
 */
export function countTeamLaneAccessStmt(
  db: AquillaDb,
  teamId: number | string,
  pendingUserIds: readonly number[],
): AquillaStatement {
  return db
    .prepare(`SELECT COUNT(*)::INT AS n FROM (${teamLaneGrantBodySql(true)}) src`)
    .bind(teamId, JSON.stringify([...pendingUserIds].map(String)), teamId, teamId)
}
