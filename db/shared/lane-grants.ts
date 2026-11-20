// AQU-2355 — a lane grant grants only the lanes it lists.
//
// Under the lane read wall a member below Maintainer reads only the lanes they
// hold a `project_member_lane_roles` row for. AQU-1781 made lane creation grant
// each new lane to every member below Maintainer who already held every other
// lane: "every lane, forever", an implicit grant nobody chose. AQU-2351 rule 2
// retired it. A lane created later reaches project and org Maintainers and
// Owners (the wall waves them through) and the people or teams the creator
// picks in the same step (POST /lanes `grants`), and nobody else.
//
// One implicit grant is left, the vacuous case of the old rule: a project's
// FIRST target lane. Nobody can hold a grant for a lane that does not exist, so
// the direct members a lane-less project already has — a bare project whose
// first translation creates the `''` bridge — would otherwise read source text
// only. The first lane goes to those members. A team reaches it only through
// its attachment (AQU-2563): a team whose attachment lists no lane is not
// handed one; the creator links it in the create step (project create sends
// its teams), and the Codex import links its team to every lane it creates.
//
// Keyed by the lane's id OR its legacy tag, because the tag-keyed writers
// (`ensureProjectLaneStmts`, `ensureTargetLaneStmt`, `ensureBlankTargetBridgeStmt`)
// upsert and may not own the row the batch ends up with. Each statement reads
// the lane back out of `lanes`, so a creation that rolled back or no-opped
// grants nothing, and is `ON CONFLICT DO NOTHING`, so a re-run writes nothing.
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
 * When the lane just created is the project's only target lane, grant it to
 * every member below Maintainer with no kind='lane' scope row whose path here
 * covers it: a direct `project_members` row, or a team whose attachment covers
 * the lane (AQU-2563 — today only a `lanes_explicit = false` row that migration
 * 0208 has not converted yet). On a project that already had a target lane
 * (archived included) it selects nothing. Safe to splice into the batch that
 * creates the lane.
 *
 * Only a lane created IN THIS TRANSACTION (`lanes.created_at = now()`, which
 * Postgres fixes at the transaction's start). The tag-keyed writers splice this
 * into every write that names the lane — every default-lane translation, every
 * import — not only the one that creates it; without the check, a later write
 * would hand the project's one lane back to a member a lead had removed from it
 * (the AQU-2557 leak). A caller that created the lane in an earlier statement
 * of its own, outside the batch, passes `{ createdByCaller: true }`.
 *
 * Returns a list so callers splice it the same way whatever it grows to.
 */
export function firstTargetLaneStmts(
  db: AquillaDb,
  projectId: string,
  ref: NewLaneRef,
  grantedBy: number | null,
  opts: { createdByCaller?: boolean } = {},
): AquillaStatement[] {
  const key = laneKeyColumn(ref)
  const fresh = opts.createdByCaller ? "" : "AND l.created_at = now()"
  const onlyLane = `NOT EXISTS (
            SELECT 1 FROM lanes other
             WHERE other.project_id = ?
               AND other.role = 'target'
               AND other.id <> l.id
          )
          ${fresh}`
  const members = db
    .prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by, team_group_id)
       SELECT ?, m.user_id, l.id, m.role_level, ?,
              -- AQU-2355 (0209): a team-only member's row is that team's.
              CASE WHEN EXISTS (SELECT 1 FROM project_members pm0
                                 WHERE pm0.project_id = l.project_id AND pm0.user_id = m.user_id)
                   THEN NULL
                   ELSE (SELECT MIN(ga.group_id) FROM group_project_grants ga
                           JOIN group_members gma ON gma.group_id = ga.group_id
                          WHERE ga.project_id = l.project_id
                            AND gma.user_id = m.user_id
                            AND ${attachmentCoversLaneSql("ga", "l.id")})
              END
         FROM (${projectWallMembersSql()}) m
         JOIN lanes l
           ON l.project_id = ?
          AND l.role = 'target'
          AND l.${key.column} = ?
        WHERE m.role_level >= ${GRANT_MIN_ROLE}
          AND m.role_level < ${GRANT_BELOW_ROLE}
          AND NOT EXISTS (
            SELECT 1 FROM project_member_scopes s
             WHERE s.project_id = ?
               AND s.user_id = m.user_id
               AND s.kind = 'lane'
          )
          AND ${onlyLane}
          AND (EXISTS (SELECT 1 FROM project_members pm
                        WHERE pm.project_id = l.project_id
                          AND pm.user_id = m.user_id)
               OR ${memberTeamAttachmentSql("m.user_id", "l.project_id", attachmentCoversLaneSql("ga", "l.id"))})
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    // AQU-2563: the last condition keeps out a member whose only path here is
    // a team whose attachment does not list this lane. It reads the project
    // through `l`, so it adds no placeholder.
    // Eight placeholders, in textual order: the row's project id, grantedBy,
    // the two the member source takes, the lane join's project id, the lane
    // key, the scope sub-select's and the only-lane sub-select's project ids.
    .bind(projectId, grantedBy, projectId, projectId, projectId, key.value, projectId, projectId)
  return [members]
}

/**
 * {@link firstTargetLaneStmts} for a caller that has just created the lane
 * itself, in an earlier statement (POST /lanes).
 */
export async function grantFirstTargetLane(
  db: AquillaDb,
  projectId: string,
  ref: NewLaneRef,
  grantedBy: number | null,
): Promise<void> {
  for (const stmt of firstTargetLaneStmts(db, projectId, ref, grantedBy, { createdByCaller: true })) await stmt.run()
}

/** Which attached teams {@link linkTeamsToLaneStmts} links. */
export type TeamLinkFilter =
  /** Teams the Codex migration made (`groups.legacy_uuid` set). */
  | { codex: true; groupIds?: undefined }
  /** Exactly these teams, when they are attached to the project. */
  | { groupIds: readonly number[]; codex?: undefined }

/**
 * AQU-2355 — link attached teams to one lane, and give their members the lane.
 *
 * A team attachment lists its lanes (`group_project_lanes`); a lane created
 * later is not one of them. The Codex import is the writer that used to rely
 * on "every lane, forever" (`lanes_explicit = false`) — it attaches each project
 * to its GitLab team, then the content sweep creates the lanes — so it now
 * names the team for each lane it creates.
 *
 * Members get the same rows `grantTeamLaneAccessStmt` writes, at the team's
 * level for them, except a direct member who already holds a kind='lane'
 * scope: a lead narrowed them on purpose (AQU-1818), and a team link must not
 * widen that. A team-only member with scope rows gets the lane's scope row
 * too, so the stored scopes keep matching their team's lanes.
 */
export function linkTeamsToLaneStmts(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  filter: TeamLinkFilter,
  grantedBy: number | null,
): AquillaStatement[] {
  const groupFilter = filter.codex
    ? `EXISTS (SELECT 1 FROM groups g WHERE g.id = gpg.group_id AND g.legacy_uuid IS NOT NULL)`
    : `gpg.group_id IN (SELECT x.v::BIGINT FROM jsonb_array_elements_text(?::jsonb) AS x(v))`
  const groupParam = filter.codex ? [] : [JSON.stringify(filter.groupIds.map(String))]
  const link = db
    .prepare(
      `INSERT INTO group_project_lanes (group_id, project_id, lane_id)
       SELECT gpg.group_id, gpg.project_id, l.id
         FROM group_project_grants gpg
         JOIN lanes l ON l.project_id = gpg.project_id AND l.role = 'target' AND l.id = ?
        WHERE gpg.project_id = ?
          AND ${groupFilter}
       ON CONFLICT DO NOTHING`,
    )
    .bind(laneId, projectId, ...groupParam)
  const level = `GREATEST(gpg.role_level, COALESCE(gm.role_level, 0))`
  const members = `FROM group_project_grants gpg
         JOIN group_project_lanes gpl
           ON gpl.group_id = gpg.group_id AND gpl.project_id = gpg.project_id AND gpl.lane_id = ?
         JOIN group_members gm ON gm.group_id = gpg.group_id
        WHERE gpg.project_id = ?
          AND ${groupFilter}
          AND ${level} >= ${GRANT_MIN_ROLE}
          AND ${level} < ${GRANT_BELOW_ROLE}`
  const directScoped = `EXISTS (SELECT 1 FROM project_members pm
                             WHERE pm.project_id = gpg.project_id AND pm.user_id = gm.user_id)
                AND EXISTS (SELECT 1 FROM project_member_scopes s
                             WHERE s.project_id = gpg.project_id AND s.user_id = gm.user_id AND s.kind = 'lane')`
  const grants = db
    .prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by, team_group_id)
       SELECT gpg.project_id, gm.user_id, gpl.lane_id, MAX(${level}), ?, MIN(gpg.group_id)
         ${members}
          AND NOT (${directScoped})
        GROUP BY gpg.project_id, gm.user_id, gpl.lane_id
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    .bind(grantedBy, laneId, projectId, ...groupParam)
  const scopes = db
    .prepare(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       SELECT DISTINCT gpg.project_id, gm.user_id, 'lane', gpl.lane_id, ?, (EXTRACT(EPOCH FROM now()) * 1000)::bigint
         ${members}
          AND NOT EXISTS (SELECT 1 FROM project_members pm
                           WHERE pm.project_id = gpg.project_id AND pm.user_id = gm.user_id)
          AND EXISTS (SELECT 1 FROM project_member_scopes s
                       WHERE s.project_id = gpg.project_id AND s.user_id = gm.user_id AND s.kind = 'lane')
       ON CONFLICT DO NOTHING`,
    )
    .bind(grantedBy == null ? "0" : String(grantedBy), laneId, projectId, ...groupParam)
  return [link, grants, scopes]
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
//   - lane creation                          → the AQU-1781 grant, also
//     keyed on `project_members` (retired by AQU-2355; see above)
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
//   1. `projectWallMembersSql` makes lane creation see the team path. Since
//      AQU-2355 that is the first lane only (`firstTargetLaneStmts`); the
//      Codex content sweep links its team to each later lane it creates
//      (`linkTeamsToLaneStmts`).
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
// are that rule as SQL, so the sync's team seeding and a lane-less project's
// first lane (`firstTargetLaneStmts`, AQU-2355) follow it too. A living
// attachment (`lanes_explicit = false`) covers every lane, which is what both
// statements did for every attachment before; AQU-2355 stops writing such rows
// and migration 0208 converts the ones left.

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
 * them deliberately, and widening that silently is a regression. A
 * `kind='lane'` scope row says the same thing on the legacy table. Together those two make the write idempotent — the second run finds
 * the rows it wrote and selects nothing.
 *
 * Archived lanes are granted too, exactly as `applyDirectAddLaneGrants` does.
 * They reveal nothing on their own — an archived lane is not one of the lanes a
 * project shows — and they keep the member's access whole if the lane is
 * restored. This deviates from AQU-1800's "archived lanes are never granted":
 * the spec's *Admission writes the whole of a member's access* says archived
 * included, and the team path must not drift from the direct one. (Since
 * AQU-2563 and AQU-2355 an attachment covers only the lanes it lists, which
 * are current lanes, so in practice archived lanes come from a living
 * `lanes_explicit = false` row that migration 0208 has not converted yet.)
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
                 -- AQU-2355 (0209): the team this row exists because of.
                 CASE WHEN ${attachmentCoversLaneSql("gpg", "l.id")} THEN gpg.group_id
                      ELSE (SELECT MIN(ga.group_id) FROM group_project_grants ga
                              JOIN group_members gma ON gma.group_id = ga.group_id
                             WHERE ga.project_id = gpg.project_id
                               AND gma.user_id = gm.user_id
                               AND ${attachmentCoversLaneSql("ga", "l.id")})
                 END AS team_group_id,
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
       INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by, team_group_id)
       SELECT src.project_id, src.user_id, src.lane, src.role_level, ?, src.team_group_id
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
