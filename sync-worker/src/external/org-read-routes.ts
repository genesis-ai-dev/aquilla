// Org-scoped external reads (AQU-1236).
//
//   GET /api/v1/external/orgs                    — orgs the credential covers
//   GET /api/v1/external/orgs/:orgId/projects    — that org's projects
//   GET /api/v1/external/orgs/:orgId/members     — that org's governance roster
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
// PII: for /orgs and /orgs/:orgId/projects, ids, names, and the caller's own
// role level only — no member lists or emails (see orgs-list.ts). The roster
// added by AQU-2662 is the one org read that names people, and it pays for that
// with an OWNER floor rather than the member-level floor the other two carry;
// it still returns no emails. See org-members-read.ts.

import { credentialAllowsOrganization } from '../../../db/shared/api-credentials'
import { errorResponse, externalError } from "./errors"
import { listOrgMembers, ORG_MEMBERS_READ_FLOOR, resolveOrgMemberLevel } from "./org-members-read"
import { listOrgsForCredential } from "./orgs-list"
import { listProjectsForCredential } from "./projects-list"
import { authenticateCredential, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import type { ApiCredentialContext } from "../../../db/shared/api-credentials"

const ORGS_RE = /^\/api\/v1\/external\/orgs$/
const ORG_PROJECTS_RE = /^\/api\/v1\/external\/orgs\/([^/]+)\/projects$/
const ORG_MEMBERS_RE = /^\/api\/v1\/external\/orgs\/([^/]+)\/members$/

/**
 * Assert a client-supplied org id is inside the credential's scope.
 *
 * An org-scoped credential may only name its own org. A project-scoped
 * credential may only name the org owning that project — resolved from the
 * project row, not taken on the caller's word. An unscoped credential may name
 * any org; whether it can actually *see* it is then decided by the membership
 * filter in the list query, which is the same check the portal applies.
 */
export async function assertOrgInCredentialScope(
  db: AquillaDb,
  cred: ApiCredentialContext,
  orgId: string,
): Promise<Response | null> {
  if (!credentialAllowsOrganization(cred, orgId)) {
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
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential)
  if (limited) return limited
  // AQU-2504: the route name, so a support-access audit row says which adapter
  // the operator used rather than defaulting to the MCP tool's name.
  const orgs = await listOrgsForCredential(
    env.AQUILLA_PG,
    authed.credential,
    "GET /api/v1/external/orgs",
  )
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
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential)
  if (limited) return limited

  const denied = await assertOrgInCredentialScope(env.AQUILLA_PG, authed.credential, orgId)
  if (denied) return denied

  const projects = await listProjectsForCredential(env.AQUILLA_PG, authed.credential, {
    orgId,
    tool: "GET /api/v1/external/orgs/:orgId/projects",
  })
  return Response.json({ data: projects, nextCursor: null })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/orgs/:orgId/members — the org governance roster
// (AQU-2662): who holds an org role, at what level, whether they hold an
// `org_members` row, and who sits in the organization's owner seat.
//
// OWNER-floored, like the AddOrgMember / SetOrgRole / RemoveOrgMember commands
// it feeds. Before this read, an agent could only discover the roster by
// staging an org-membership command and reading the refusal back.
// ---------------------------------------------------------------------------

async function handleExternalOrgMembers(
  request: Request,
  env: ExternalReadsEnv,
  orgIdParam: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential)
  if (limited) return limited

  // Same refusal as resolveOrgMemberGate: org governance is out of reach for a
  // project-scoped credential, read half included. Checked before the scope
  // helper, which would otherwise let such a credential name its own org.
  if (authed.credential.projectId != null) {
    return externalError(
      "scope_denied",
      "a project-scoped credential cannot read the org membership roster",
      403,
    )
  }

  const orgId = Number(orgIdParam)
  if (!Number.isInteger(orgId)) {
    return externalError("validation_failed", "orgId must be an integer org id", 400)
  }
  const denied = await assertOrgInCredentialScope(env.AQUILLA_PG, authed.credential, String(orgId))
  if (denied) return denied

  // The caller's LIVE org level, through the same resolver the write gate
  // calls — no platform-admin elevation, no owner-seat fallback.
  const callerLevel = await resolveOrgMemberLevel(
    env.AQUILLA_PG as AquillaDb,
    orgId,
    authed.credential.userId,
  )
  if (callerLevel == null || callerLevel < ORG_MEMBERS_READ_FLOOR) {
    // Same envelope and `requiredRole` detail as the write half's denial, so a
    // caller that already handles that refusal needs no new branch here.
    return errorResponse(
      "permission_denied",
      "org role owner is required to read the org membership roster",
      { requiredRole: ORG_MEMBERS_READ_FLOOR },
    )
  }

  const roster = await listOrgMembers(env.AQUILLA_PG as AquillaDb, orgId)
  if (!roster) return externalError("not_found", `org ${orgId} not found`, 404)
  // `total` and `truncated` are always present, so a capped roster says so
  // rather than reading as the whole list. nextCursor is null by design: this
  // read does not page (see ORG_MEMBERS_MAX_ROWS).
  return Response.json({
    data: roster.members,
    total: roster.total,
    truncated: roster.truncated,
    nextCursor: null,
  })
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

  let match = url.pathname.match(ORG_PROJECTS_RE)
  if (match) return handleExternalOrgProjects(request, env, decodeURIComponent(match[1]))

  match = url.pathname.match(ORG_MEMBERS_RE)
  if (match) return handleExternalOrgMembers(request, env, decodeURIComponent(match[1]))

  return null
}
