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
// PII: id, name, and the caller's own role level only. No member lists, emails,
// or owner identities — the portal's org-member surfaces stay off this tier.
// Capped at 100 rows, matching listProjectsForCredential.

import type { ApiCredentialContext } from '../../../db/shared/api-credentials'

/** Role level granted to the row owner of an organization (org-permissions.ts). */
const OWNER_ROLE_LEVEL = 700

export interface ExternalOrgListItem {
  id: string
  name: string | null
  /** The calling user's live role level in this org. */
  role: number
  /** How access is granted: owner | member. */
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
): Promise<ExternalOrgListItem[]> {
  const uid = String(cred.userId)
  const binds: unknown[] = [uid, uid, uid, uid, uid]
  let sql =
    `SELECT o.id, o.name,
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
  if (cred.projectId !== null) {
    // A project-scoped credential sees exactly the org owning that project.
    // An org-less (personal) project makes the subquery NULL, so nothing
    // matches and the list is empty — which is the honest answer.
    sql += ` AND o.id::text = (SELECT p.org_id::text FROM projects p WHERE p.id = ?)`
    binds.push(cred.projectId)
  }
  sql += ` ORDER BY LOWER(COALESCE(o.name, '')), o.id LIMIT 100`

  const result = await db.prepare(sql).bind(...binds).all<OrgListRow>()
  return result.results.map((r) => ({
    id: String(r.id),
    name: r.name,
    role: Number(r.role),
    role_source: r.role_source,
  }))
}
