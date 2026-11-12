// Shared "which orgs can this credential see" query for the Agent API (AQU-1236).
//
// Used by both the MCP `list_orgs` tool (mcp-handlers.ts) and the REST
// `GET /api/v1/external/orgs` route (org-read-routes.ts) so the two adapters
// can never drift — the same pairing projects-list.ts already has for projects.
//
// Visibility mirrors what the credential's minting user sees in the portal's org
// switcher (auth-worker/src/services/org-permissions.ts `listUserOrgs`): orgs
// they own (role 700) unioned with their `org_members` rows (role per row),
// owner winning on conflict. Two deliberate differences:
//
//   1. NO lazy creation. `listUserOrgs` creates a personal org when the user has
//      none so the switcher is never empty; a read on the agent surface must not
//      write, so a user with no org here simply gets an empty list.
//   2. Narrowed to the credential's scope — an org-scoped credential sees only
//      that org, and a project-scoped credential sees only the org owning that
//      project (nothing at all when the project is personal/org-less). A
//      credential can never enumerate orgs outside its scope.
//
// AQU-2504 adds ONE deliberate exception to difference 2: a credential carrying
// live SUPPORT ACCESS (a platform admin, inside their time-boxed window — see
// db/shared/api-credentials.ts) drops the membership filter and sees every org,
// because looking at the customer's workspace they are messaging you about is
// the entire point. Its `role` reads 700 / `platform`, the same owner-level
// contribution resolveProjectRoleShared gives a platform operator on the web.
// The credential's own org/project scope still narrows the result — support
// access widens WHO is a member, never what the token was scoped to. The
// enumeration is written to `admin_audit_log`, once per call.
//
// PII: id, name, and the caller's own role level only. No member lists, emails,
// or owner identities — the portal's org-member surfaces stay off this tier.
// Capped at 100 rows, matching listProjectsForCredential.

import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { auditSupportAccessRead } from '../../../db/shared/support-access-audit'

/** Role level granted to the row owner of an organization (org-permissions.ts). */
const OWNER_ROLE_LEVEL = 700

export interface ExternalOrgListItem {
  id: string
  name: string | null
  /** The calling user's live role level in this org. */
  role: number
  /** How access is granted: owner | member | platform (AQU-2504). */
  role_source: string
}

interface OrgListRow {
  id: number | string | bigint
  name: string | null
  role: number | string
  role_source: string
}

export async function listOrgsForCredential(
  db: AquillaDb,
  cred: ApiCredentialContext,
  /** The tool or route asking, for the support-access audit row. */
  tool = 'list_orgs',
): Promise<ExternalOrgListItem[]> {
  const uid = String(cred.userId)
  const support = cred.supportAccess === true
  // Support access replaces the membership predicate with `true` and reports
  // owner-level / 'platform'; everyone else keeps the owner-or-member rule and
  // their real level. The support branch binds nothing of its own (there is no
  // membership to match), so the scope clauses below append to either shape
  // unchanged — they are positional and go on the end in both.
  const binds: unknown[] = support ? [] : [uid, uid, uid, uid, uid]
  let sql = support
    ? `SELECT o.id, o.name, ${OWNER_ROLE_LEVEL} AS role, 'platform' AS role_source
       FROM organizations o
       WHERE true`
    : `SELECT o.id, o.name,
       GREATEST(
         CASE WHEN o.owner_user_id::text = ? THEN ${OWNER_ROLE_LEVEL} ELSE 0 END,
         COALESCE((SELECT om.role_level FROM org_members om
                    WHERE om.org_id = o.id AND om.user_id::text = ?), 0)
       ) AS role,
       CASE WHEN o.owner_user_id::text = ? THEN 'owner' ELSE 'member' END AS role_source
     FROM organizations o
     WHERE (
       o.owner_user_id::text = ?
       OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = o.id AND om.user_id::text = ?)
     )`
  if (cred.orgId !== null) {
    sql += ` AND o.id::text = ?`
    binds.push(cred.orgId)
  }
  if (cred.orgIds !== undefined) {
    if (cred.orgIds.length === 0) return []
    sql += ` AND o.id::text IN (${cred.orgIds.map(() => '?').join(', ')})`
    binds.push(...cred.orgIds)
  }
  if (cred.projectId !== null) {
    // A project-scoped credential sees exactly the org owning that project.
    // An org-less (personal) project makes the subquery NULL, so nothing
    // matches and the list is empty — which is the honest answer.
    sql += ` AND o.id::text = (SELECT p.org_id::text FROM projects p WHERE p.id = ?)`
    binds.push(cred.projectId)
  }
  sql += ` ORDER BY LOWER(COALESCE(o.name, '')), o.id LIMIT 100`

  const result = await db.prepare(sql).bind(...binds).all<OrgListRow>()
  const orgs = result.results.map((r) => ({
    id: String(r.id),
    name: r.name,
    role: Number(r.role),
    role_source: r.role_source,
  }))
  if (support) {
    await auditSupportAccessRead(db, uid, {
      action: 'connector.orgs.list',
      credentialId: cred.credentialId,
      tool,
      orgIds: orgs.map((o) => o.id),
    })
  }
  return orgs
}
