/**
 * Thin HTTP client for identity, used by E2E specs to set up
 * server-side state (projects, org members, project members) without
 * driving brittle UI flows.
 *
 * The production app uses the same endpoints via wrappers in
 * src/lib/frontier/. This helper duplicates the minimal subset needed
 * for tests rather than importing from src/ to keep the test surface
 * isolated from product code refactors.
 *
 * Role levels (mirror src/lib/frontier/roles.ts):
 *   100 viewer, 200 commenter, 300 reviewer, 400 contributor,
 *   500 project_lead, 600 maintainer, 700 owner.
 */

const AUTH_BASE = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"

export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

export interface MyOrg {
  id: number
  name: string | null
  role: { level: number; name: string }
}

/** GET /api/v2/orgs/me — alice's seeded "Acme" org. Returns the row even
 * if she's never explicitly created one (identity lazy-creates a
 * personal org on first call). */
export async function getMyOrg(jwt: string): Promise<MyOrg> {
  const r = await fetch(`${AUTH_BASE}/api/v2/orgs/me`, { headers: authHeaders(jwt) })
  if (!r.ok) throw new Error(`getMyOrg failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as MyOrg
}

/** POST /api/v2/orgs/:orgId/members — add a user to an org by username.
 * Caller must be owner/maintainer of the org. Used in tests where alice
 * adds bob to Acme. */
export async function addOrgMember(
  jwt: string,
  orgId: number,
  username: string,
  role: number = ROLE.CONTRIBUTOR,
): Promise<void> {
  const r = await fetch(`${AUTH_BASE}/api/v2/orgs/${orgId}/members`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ username, role }),
  })
  if (!r.ok) throw new Error(`addOrgMember failed: HTTP ${r.status} — ${await r.text()}`)
}

export interface CreatedProject {
  id: string
  name: string
  orgId: number
  role: { level: number; name: string }
}

/** POST /api/v2/projects — register a project server-side under the caller's
 * personal org. Used to bootstrap a project that has both local IDB state
 * AND a server-side row, so subsequent member-add and sync calls succeed. */
export async function createProjectServerSide(
  jwt: string,
  args: { id: string; name: string },
): Promise<CreatedProject> {
  const r = await fetch(`${AUTH_BASE}/api/v2/projects`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(args),
  })
  if (!r.ok) throw new Error(`createProjectServerSide failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as CreatedProject
}

/** POST /api/v2/projects/:projectId/members — add a user to a project. */
export async function addProjectMember(
  jwt: string,
  projectId: string,
  username: string,
  role: number = ROLE.CONTRIBUTOR,
): Promise<void> {
  const r = await fetch(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ username, role }),
    },
  )
  if (!r.ok) throw new Error(`addProjectMember failed: HTTP ${r.status} — ${await r.text()}`)
}

/** Convenience: create project server-side AND add another user as a
 * contributor in one call. Returns the project id. */
export async function bootstrapSharedProject(
  ownerJwt: string,
  args: { id: string; name: string; collaboratorUsername: string; collaboratorRole?: number },
): Promise<CreatedProject> {
  const project = await createProjectServerSide(ownerJwt, { id: args.id, name: args.name })
  await addProjectMember(
    ownerJwt,
    project.id,
    args.collaboratorUsername,
    args.collaboratorRole ?? ROLE.CONTRIBUTOR,
  )
  return project
}
