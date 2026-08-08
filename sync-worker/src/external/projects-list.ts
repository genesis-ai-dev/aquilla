// Shared "which projects can this credential see" query for the Agent API.
//
// Used by both the MCP `list_projects` tool (mcp-handlers.ts) and the REST
// `GET /api/v1/external/projects` route (read-routes.ts) so the two adapters
// can never drift. Visibility = created-by OR project membership OR org
// membership at Maintainer+ (AQU-435 floor — mirrors resolveProjectRole /
// resolveProjectRoleShared so a sub-maintainer org member can't enumerate
// projects they have no in-app grant to), further narrowed to the
// credential's org/project scope. Archived projects are excluded. Capped at
// 100 rows.

import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { ROLE } from '../events/role-policy'

export interface ExternalProjectListItem {
  id: string
  name: string
  org_id: string | null
  /** How access is granted: creator | member | org. */
  role_source: string
}

interface ProjectListRow {
  id: string
  name: string
  org_id: number | string | bigint | null
  role_source: string
}

export async function listProjectsForCredential(
  db: AquillaDb,
  cred: ApiCredentialContext,
): Promise<ExternalProjectListItem[]> {
  const uid = String(cred.userId)
  const binds: unknown[] = [uid, uid, uid, uid, uid]
  let sql =
    `SELECT p.id, p.name, p.org_id,
       CASE
         WHEN p.created_by::text = ? THEN 'creator'
         WHEN EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id::text = ?) THEN 'member'
         ELSE 'org'
       END AS role_source
     FROM projects p
     WHERE p.archived_at IS NULL
       AND (
         p.created_by::text = ?
         OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id::text = ?)
         OR (p.org_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM org_members om
           WHERE om.org_id = p.org_id AND om.user_id::text = ? AND om.role_level >= ${ROLE.MAINTAINER}
         ))
       )`
  if (cred.projectId !== null) {
    sql += ` AND p.id = ?`
    binds.push(cred.projectId)
  }
  if (cred.orgId !== null) {
    sql += ` AND p.org_id::text = ?`
    binds.push(cred.orgId)
  }
  sql += ` ORDER BY p.name LIMIT 100`

  const result = await db.prepare(sql).bind(...binds).all<ProjectListRow>()
  return result.results.map((r) => ({
    id: r.id,
    name: r.name,
    org_id: r.org_id == null ? null : String(r.org_id),
    role_source: r.role_source,
  }))
}
