/**
 * Thin HTTP client for the identity worker, used by E2E specs to set up
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

import { postIdempotentJson } from "./idempotent-request"

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

function authHeaders(jwt: string): Record<string, string> {
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
 * if she's never explicitly created one (frontier-server lazy-creates a
 * personal org on first call). */
export async function getMyOrg(jwt: string): Promise<MyOrg> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/me`, { headers: authHeaders(jwt) })
  if (!r.ok) throw new Error(`getMyOrg failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as MyOrg
}

/** GET /api/v2/orgs — every organization visible to the caller. */
export async function listMyOrgs(jwt: string): Promise<MyOrg[]> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs`, { headers: authHeaders(jwt) })
  if (!r.ok) throw new Error(`listMyOrgs failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { orgs: MyOrg[] }).orgs
}

/** POST /api/v2/orgs — create a named org owned by the caller. */
export async function createOrg(jwt: string, name: string): Promise<MyOrg> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ name }),
  })
  if (!r.ok) throw new Error(`createOrg failed: HTTP ${r.status} — ${await r.text()}`)
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
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
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
  args: { id: string; name: string; orgId?: number },
): Promise<CreatedProject> {
  // The caller supplies a stable project id and the worker insert uses
  // ON CONFLICT(id) DO NOTHING, so replaying this byte-identical fixture POST
  // is safe when Wrangler restarts after accepting or during the request.
  const r = await postIdempotentJson({
    url: `${FRONTIER_BASE}/api/v2/projects`,
    headers: authHeaders(jwt),
    body: args,
    operation: "createProjectServerSide",
  })
  return (await r.json()) as CreatedProject
}

/** GET /api/v2/projects/:projectId/settings — the stored shared-settings blob,
 * for specs asserting that a UI save actually reached auth-worker. */
export async function readProjectSettings(
  jwt: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    { headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`read settings failed: HTTP ${r.status} — ${await r.text()}`)
  const stored = (await r.json()) as { settings?: Record<string, unknown> }
  return stored.settings ?? {}
}

/** PUT /api/v2/projects/:projectId/settings — merge keys into a project's
 * settings. Caller needs maintainer+ (the route's own floor). */
export async function updateProjectSettings(
  jwt: string,
  projectId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const current = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    { headers: authHeaders(jwt) },
  )
  if (!current.ok) {
    throw new Error(`read settings failed: HTTP ${current.status} — ${await current.text()}`)
  }
  const stored = (await current.json()) as { settings?: Record<string, unknown>; version?: number }
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    {
      method: "PUT",
      headers: authHeaders(jwt),
      body: JSON.stringify({
        settings: { ...(stored.settings ?? {}), ...settings },
        ifMatchVersion: stored.version ?? 0,
      }),
    },
  )
  if (!r.ok) {
    throw new Error(`update settings failed: HTTP ${r.status} — ${await r.text()}`)
  }
}

/** One row of the `lanes` list GET …/settings returns alongside the blob. */
export interface ProjectLane {
  id: string
  role: "source" | "target"
  name: string
  langCode: string | null
  legacyTag: string | null
  archivedAt: string | null
}

/** GET /api/v2/projects/:projectId/settings — the project's lane records
 * (what the lane switcher and Settings → Languages list), not the tag registry
 * in the settings blob. */
export async function readProjectLanes(jwt: string, projectId: string): Promise<ProjectLane[]> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    { headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`read lanes failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { lanes?: ProjectLane[] }).lanes ?? []
}

/** PATCH /api/v2/projects/:projectId/lanes/:laneId — rename a target lane, as
 * Settings → Languages does. Returns the HTTP status for the spec to assert. */
export async function renameProjectLane(
  jwt: string,
  projectId: string,
  laneId: string,
  name: string,
): Promise<number> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/lanes/${encodeURIComponent(laneId)}`,
    { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name }) },
  )
  return r.status
}

/** POST /api/v2/projects/:projectId/link-source — make `projectId` read its
 * source from another project. `seeded` reports whether the upstream's files
 * and cells arrived before the call returned. */
export async function linkProjectToSource(
  jwt: string,
  projectId: string,
  args: {
    sourceProjectId: string
    mode: "clone" | "live"
    consumes?: "source" | "target"
    gate?: "head" | "validated"
    /** AQU-1605: which of the upstream's lanes to consume (`lanes.id`). Omit for
     *  its former default lane, which is what every link read before that slice. */
    laneId?: string
  },
): Promise<{ seeded: boolean }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/link-source`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(args) },
  )
  if (!r.ok) throw new Error(`link-source failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as { seeded: boolean }
}

export interface MergeSiblingResponse {
  merged?: number
  skipped?: Array<{ cellId: string; preview: string }>
  lane?: string
  actions?: { laneRegistered: boolean; donorArchived: boolean; donorPointerWritten: boolean }
  error?: string
}

/** POST /api/v2/projects/:hostId/merge-sibling — fold a sibling project into
 * the host as one more target lane. There is no UI for this yet; the route is
 * the product surface. Returns status + body so a spec can assert a refusal. */
export async function mergeSiblingProject(
  jwt: string,
  hostProjectId: string,
  args: { donorProjectId: string; lane: string },
): Promise<{ status: number; body: MergeSiblingResponse }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(hostProjectId)}/merge-sibling`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(args) },
  )
  const text = await r.text()
  let body: MergeSiblingResponse
  try {
    body = JSON.parse(text) as MergeSiblingResponse
  } catch {
    body = { error: text }
  }
  return { status: r.status, body }
}

/** POST /api/v2/projects/:projectId/invites — mint a share-link invite
 * (caller needs project_lead+). Pass an email to email-bind it. */
export async function createProjectInvite(
  jwt: string,
  projectId: string,
  opts: { email?: string; role?: number } = {},
): Promise<{ token: string }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/invites`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify(opts),
    },
  )
  if (!r.ok) throw new Error(`createProjectInvite failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as { token: string }
}

/** POST /api/v2/orgs/:orgId/invites — mint an org invite (owner-only). */
export async function createOrgInvite(
  jwt: string,
  orgId: number,
  opts: { email?: string; role?: number } = {},
): Promise<{ token: string }> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/invites`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(opts),
  })
  if (!r.ok) throw new Error(`createOrgInvite failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as { token: string }
}

/** POST /api/v2/projects/:projectId/members — add a user to a project. */
export async function addProjectMember(
  jwt: string,
  projectId: string,
  username: string,
  role: number = ROLE.CONTRIBUTOR,
): Promise<void> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ username, role }),
    },
  )
  if (!r.ok) throw new Error(`addProjectMember failed: HTTP ${r.status} — ${await r.text()}`)
}

/** POST /api/v2/auth/register — mint a throwaway account for specs that need
 * more than the alice/bob/carol seed (AQU-1060). Does not persist a sidecar. */
export async function registerAccount(args: {
  username: string
  email: string
  password: string
}): Promise<{ jwt: string; username: string; email: string }> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  if (!r.ok) {
    throw new Error(`registerAccount failed: HTTP ${r.status} — ${await r.text()}`)
  }
  const body = (await r.json()) as { access_token: string }
  return { jwt: body.access_token, username: args.username, email: args.email }
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
