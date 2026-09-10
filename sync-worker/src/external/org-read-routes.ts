// Org-scoped external reads (AQU-1236).
//
//   GET /api/v1/external/orgs                    — orgs the credential covers
//   GET /api/v1/external/orgs/:orgId/projects    — that org's projects
//
// Why: PATs are already scoped org-or-project, but the read surface only ever
// exposed the single scoped project, so an AI console managing a partner's whole
// workspace had to mint and juggle one token per project. An org-scoped
// credential can now enumerate its orgs and each org's projects with the one
// token it already holds.
//
// Narrowing, never widening: every query runs through the credential scope in
// orgs-list.ts / projects-list.ts. A PROJECT-scoped credential gets exactly its
// own project's org from /orgs and exactly that one project from
// /orgs/:orgId/projects — it cannot see its org's siblings. An out-of-scope
// orgId is refused with scope_denied rather than quietly returning [], so the
// caller learns the difference between "not yours" and "empty".
//
// PII: ids, names, and the caller's own role level. No member lists or emails —
// see orgs-list.ts.

import { externalError } from "./errors"
import { listOrgsForCredential } from "./orgs-list"
import { listProjectsForCredential } from "./projects-list"
import { authenticateCredential, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import type { ApiCredentialContext } from "../../../db/shared/api-credentials"

const ORGS_RE = /^\/api\/v1\/external\/orgs$/
const ORG_PROJECTS_RE = /^\/api\/v1\/external\/orgs\/([^/]+)\/projects$/

/**
 * Assert a client-supplied org id is inside the credential's scope.
 *
 * An org-scoped credential may only name its own org. A project-scoped
 * credential may only name the org owning that project — resolved from the
 * project row, not taken on the caller's word. An unscoped credential may name
 * any org; whether it can actually *see* it is then decided by the membership
 * filter in the list query, which is the same check the portal applies.
 */
async function assertOrgInCredentialScope(
  db: AquillaDb,
  cred: ApiCredentialContext,
  orgId: string,
): Promise<Response | null> {
  if (cred.orgId !== null && cred.orgId !== orgId) {
    return externalError("scope_denied", "credential is not scoped to this org", 403)
  }
  if (cred.projectId !== null) {
    const row = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(cred.projectId)
      .first<{ org_id: number | string | bigint | null }>()
    const projectOrgId = row?.org_id == null ? null : String(row.org_id)
    if (projectOrgId !== orgId) {
      return externalError(
        "scope_denied",
        "credential is scoped to a single project, which is not in this org",
        403,
      )
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/orgs
// ---------------------------------------------------------------------------

async function handleExternalOrgs(request: Request, env: ExternalReadsEnv): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential.credentialId)
  if (limited) return limited
  const orgs = await listOrgsForCredential(env.AQUILLA_PG, authed.credential)
  return Response.json({ data: orgs, nextCursor: null })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/orgs/:orgId/projects
// ---------------------------------------------------------------------------

async function handleExternalOrgProjects(
  request: Request,
  env: ExternalReadsEnv,
  orgId: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential.credentialId)
  if (limited) return limited

  const denied = await assertOrgInCredentialScope(env.AQUILLA_PG, authed.credential, orgId)
  if (denied) return denied

  const projects = await listProjectsForCredential(env.AQUILLA_PG, authed.credential, { orgId })
  return Response.json({ data: projects, nextCursor: null })
}

// ---------------------------------------------------------------------------
// Router — mounted from read-routes.ts's router (GET-only, already checked).
// ---------------------------------------------------------------------------

export async function handleExternalOrgReadRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (ORGS_RE.test(url.pathname)) return handleExternalOrgs(request, env)

  const match = url.pathname.match(ORG_PROJECTS_RE)
  if (match) return handleExternalOrgProjects(request, env, decodeURIComponent(match[1]))

  return null
}
