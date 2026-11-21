// The ORG membership roster for the Agent API (AQU-2662).
//
// AQU-1235 shipped AddOrgMember / SetOrgRole / RemoveOrgMember, and AQU-1236
// gave an org-scoped credential `GET /orgs` and `GET /orgs/:orgId/projects` —
// but deliberately "no member lists" (see org-read-routes.ts). So the org half
// of governance had the same hole AQU-2403 closed for projects: an agent could
// only discover who holds an org role by staging a command and reading the
// refusal back (`is already a member` vs `is not a member of this org`).
//
// Probing a governance surface for its own state is how you stage a change
// nobody asked for. The live case this comes from: a partner lead asked for an
// org MAINTAINER to be confined to 5 of the org's 18 projects. The fix is
// RemoveOrgMember + N × InviteMember — and you cannot plan it without first
// knowing that she holds the projects through the ORG path rather than through
// a row on each project.
//
// Two properties this read exists to carry:
//
//   1. `role` AGREES WITH THE GATE. It is the `org_members.role_level` the
//      commands act on and `resolveOrgMemberGate` compares against — resolved
//      through the SAME `resolveOrgMemberLevel` the gate calls, not a mirror of
//      it. It is deliberately NOT the max-wins blend `listOrgsForCredential`
//      reports for the caller's own orgs: that one folds in the
//      `organizations.owner_user_id` seat, and a roster that claimed 700 for
//      somebody the gate then sees at 400 would hand an agent a plan the gate
//      refuses. The seat is reported as its own field instead (see below).
//
//   2. `direct` picks the command, exactly as it does on the project roster.
//      A direct member (an `org_members` row) is re-roled with SetOrgRole and
//      dropped with RemoveOrgMember; both are rejected with `is not a member of
//      this org` without a row, and AddOrgMember is rejected with `is already a
//      member` when there is one.
//
// `orgOwner` is the third field, and the one with no project-roster twin: it
// marks the holder of `organizations.owner_user_id`. That seat is what the
// last-OWNER guard in org-members-engine.ts refuses to demote or remove, so it
// is the difference between "an owner you may re-role" and "the owner you may
// not" — and nothing in `role` or `direct` carries it. A seat holder with no
// `org_members` row at all (possible: `listOrgsForCredential` grants the seat
// 700 independently of the table) is reported at 700 with `roleSource: 'owner'`
// and `direct: false`, which is the honest answer — they own the org, and there
// is no row for SetOrgRole to move.
//
// Floor: OWNER, pinned equal to the write floor by a test, the same way
// members-read.ts pins the project roster to MAINTAINER. Org membership is
// owner-only to change (AQU-780), so it is owner-only to enumerate: a caller
// who cannot act on the roster has no business reading it through a machine
// credential. That floor also sits at or above any value of the org's own
// `rosterViewMinRole` policy (AQU-485, capped at 700), so this surface cannot
// be used to see around a roster the org has chosen to hide.
//
// Platform-admin elevation is NOT applied, matching resolveOrgMemberGate: the
// external API confers no cross-tenant governance authority, and unlike
// orgs-list.ts there is no support-access widening here — a roster is the one
// org read that names people.
//
// Identity: usernames pass through at face value, deliberately NOT subject to
// the pii.ts authorship policy — the same call members-read.ts makes, for the
// same reason. That policy protects translators named as the *author* of
// content (docs/OPSEC.md); a pseudonymised roster could not be fed back into
// SetOrgRole, which is the only reason to read it. The OWNER floor, not
// scrubbing, is the control. Emails are not returned at all (the org roster UI
// shows them; this tier does not need them, and the commands name people by
// username).

import { ROLE, roleLabel } from '../events/role-policy'

/** The role floor for reading the org roster. Pinned equal to the org
 *  membership write floor (org-members-engine.ts's OWNER-only gate) by a
 *  test — read and write halves of one governance surface. */
export const ORG_MEMBERS_READ_FLOOR = ROLE.OWNER

/** Most roster rows one response carries. Like the project roster this read
 *  has no cursor — a roster is a governance list, not a content feed — so it
 *  reports `total` and `truncated` instead and the caller narrows elsewhere. */
export const ORG_MEMBERS_MAX_ROWS = 500

/** Which path produced the reported role: an `org_members` row, or the
 *  `organizations.owner_user_id` seat held without one. Matches the org-tier
 *  vocabulary `listOrgsForCredential` already publishes as `role_source`
 *  (`owner` | `member`), not the project tier's override/group/org/creator. */
export type OrgRoleSource = 'member' | 'owner'

export interface OrgMemberRow {
  userId: string
  username: string
  /** The `org_members.role_level` the commands act on and the gate compares
   *  against — 700 for an owner-seat holder carrying no row. */
  role: number
  roleName: string
  roleSource: OrgRoleSource
  /** True iff an `org_members` row exists. SetOrgRole and RemoveOrgMember need
   *  one; AddOrgMember is refused when there is one. */
  direct: boolean
  /** True for the holder of `organizations.owner_user_id` — the seat the
   *  last-owner guard will not let you demote or remove. */
  orgOwner: boolean
}

/**
 * The caller's (or any user's) org role level, from `org_members` alone.
 *
 * The single resolver both halves of org governance use: the OWNER gate in
 * org-members-engine.ts calls this, and so does the roster route in front of
 * `listOrgMembers`. Sharing the function rather than repeating the statement is
 * what makes "the roster agrees with the gate" a fact instead of a comment.
 *
 * No platform-admin elevation and no owner-seat fallback: this is the number
 * AQU-780's owner-only rule is evaluated on. Null means no row.
 */
export async function resolveOrgMemberLevel(
  db: AquillaDb,
  orgId: number | string,
  userId: number | string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
    .bind(orgId, userId)
    .first<{ role_level: number }>()
  return row?.role_level ?? null
}

interface OrgRosterRow {
  user_id: string
  username: string
  role_level: number | string
  direct: boolean
}

/**
 * The org's roster: every `org_members` row, plus the `owner_user_id` seat
 * holder when they carry no row.
 *
 * Null when the org does not exist, so the route can tell that from an org
 * whose every row points at a deleted user.
 */
export async function listOrgMembers(
  db: AquillaDb,
  orgId: number | string,
): Promise<{ members: OrgMemberRow[]; total: number; truncated: boolean } | null> {
  const org = await db
    .prepare(`SELECT id::text AS id, owner_user_id::text AS owner_user_id FROM organizations WHERE id = ?`)
    .bind(orgId)
    .first<{ id: string; owner_user_id: string | null }>()
  if (!org) return null
  const ownerUserId = org.owner_user_id

  // The seat arm contributes at most one row, and only when the seat holder has
  // no `org_members` row — so `total` counts people, never double-counting an
  // owner who is also a member. INNER JOIN on users drops a row whose user has
  // since been deleted: that is a dangling row, not a member, and keeping it
  // would put a name-less entry in a list whose only use is naming people.
  const countRow = await db
    .prepare(
      `SELECT (
         (SELECT COUNT(*) FROM org_members om
            INNER JOIN users u ON u.id = om.user_id
           WHERE om.org_id = ?)
         + (SELECT COUNT(*) FROM users u
             WHERE u.id::text = ?
               AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = ? AND om.user_id = u.id))
       )::int AS n`,
    )
    .bind(orgId, ownerUserId, orgId)
    .first<{ n: number }>()
  const total = countRow?.n ?? 0
  if (total === 0) return { members: [], total, truncated: false }

  // Ordered highest role first, so a capped roster is the top of the ladder —
  // the people a membership command could be aimed at — rather than an
  // arbitrary slice. Same reasoning as MEMBERS_MAX_ROWS in members-read.ts.
  const rows = await db
    .prepare(
      // The UNION is wrapped so the ORDER BY can sort on LOWER(username): a
      // set operation's ORDER BY may only name output columns, not expressions
      // over them (`invalid UNION/INTERSECT/EXCEPT ORDER BY clause`).
      `SELECT r.user_id, r.username, r.role_level, r.direct FROM (
         SELECT om.user_id::text AS user_id, u.username AS username,
                om.role_level AS role_level, true AS direct
           FROM org_members om
           INNER JOIN users u ON u.id = om.user_id
          WHERE om.org_id = ?
         UNION ALL
         SELECT u.id::text AS user_id, u.username AS username,
                ${ROLE.OWNER} AS role_level, false AS direct
           FROM users u
          WHERE u.id::text = ?
            AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = ? AND om.user_id = u.id)
       ) r
       ORDER BY r.role_level DESC, LOWER(r.username) ASC
       LIMIT ?`,
    )
    .bind(orgId, ownerUserId, orgId, ORG_MEMBERS_MAX_ROWS)
    .all<OrgRosterRow>()

  const members: OrgMemberRow[] = (rows.results ?? []).map((r) => {
    const role = Number(r.role_level)
    const direct = r.direct === true
    return {
      userId: String(r.user_id),
      username: r.username,
      role,
      roleName: roleLabel(role),
      roleSource: direct ? 'member' : 'owner',
      direct,
      orgOwner: ownerUserId !== null && String(r.user_id) === ownerUserId,
    }
  })
  return { members, total, truncated: total > ORG_MEMBERS_MAX_ROWS }
}
