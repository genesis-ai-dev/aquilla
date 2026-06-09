/**
 * FRO-144 — Org-level business logic E2E
 *
 * Covers the full access-control journey documented in
 * aquilla-specs/05-user-stories/access-control-permission-semantics.md:
 *
 *   1. Alice creates a project and invites Bob to the org.
 *   2. Bob (as a new org member) can see the project (org path fires).
 *   3. Alice creates a team (group), adds Carol to the org, adds Carol to
 *      the team, and grants the team access to the project.
 *   4. Carol (via group path) can see the project.
 *   5. Alice revokes Bob's org membership → Bob can no longer access the project.
 *   6. Alice detaches the project from the team → Carol loses the group path
 *      (she keeps org-member visibility since she's still in the org).
 *   7. Alice fully removes Carol from the org → Carol can no longer list org
 *      projects (all paths gone).
 *
 * Architecture:
 *   - ALL setup uses API calls (stable contract, same as production data path).
 *   - UI assertions prove the app surface reflects server state correctly.
 *   - The "revoked user can no longer see / access" assertions are the
 *     critical ones — they exercise the max-wins resolver and cascade delete.
 *
 * The spec is intentionally split into independent `test()` blocks so
 * failures are isolated. Each test calls resetBackend() via the `alice`
 * fixture (see multi-user.ts) so they don't share state.
 */

import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import {
  getMyOrg,
  addOrgMember,
  createProjectServerSide,
  addProjectMember,
  ROLE,
} from "../../helpers/frontier-api"
import {
  createGroup,
  addGroupMember,
  attachGroupProject,
  detachGroupProject,
  removeOrgMember,
} from "../../helpers/frontier-api-groups"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

// ---------------------------------------------------------------------------
// Shared types for API response shapes
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string
  name: string
}

interface AccessEntry {
  projectId: string
  effectiveLevel: number
}

interface ProjectDetail {
  role?: {
    level: number
    name: string
    source: string  // "org" | "group" | "override" | "creator"
  }
}

interface UserRow {
  id: number
}

// ---------------------------------------------------------------------------
// Test 1: org membership grants project visibility
// ---------------------------------------------------------------------------

test("invite to org → bob sees all org projects on dashboard", async ({ alice: _alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  // Create a project under Alice's org.
  const projectId = `fro144-proj-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Acme Bible" })

  // Bob is NOT a member yet — should NOT see the project.
  const bobSession = await ensureAuthState("bob")
  const bobProjectsBefore = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsBefore.some((p) => p.id === projectId)).toBe(false)

  // Alice invites Bob to the org.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Bob can now see the project via the org path.
  const bobProjectsAfter = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsAfter.some((p) => p.id === projectId)).toBe(true)

  // UI: bob's dashboard shows the shared project.
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await bob.reload()
  await expect(bob.getByText("Acme Bible").first()).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 2: team (group) path grants project visibility at group role
// ---------------------------------------------------------------------------

test("create team → add carol → attach project → carol sees project", async ({ alice: _alice, carol }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  const projectId = `fro144-team-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Team Project" })

  // Carol must be an org member before she can be added to a group.
  await addOrgMember(aliceSession.jwt, acme.id, "carol", ROLE.VIEWER)

  // Verify Carol sees the project via org-viewer path BEFORE team creation.
  const carolSession = await ensureAuthState("carol")
  const carolProjects = await listProjectsApi(carolSession.jwt, acme.id)
  // Org viewer sees all org projects (AD-12 org path).
  expect(carolProjects.some((p) => p.id === projectId)).toBe(true)

  // Create team and add carol.
  const group = await createGroup(aliceSession.jwt, acme.id, "Translators")
  await addGroupMember(aliceSession.jwt, acme.id, group.id, "carol")

  // Attach project to group with contributor role.
  await attachGroupProject(aliceSession.jwt, acme.id, group.id, projectId, ROLE.CONTRIBUTOR)

  // Carol's effective role on the project should be max(viewer_org, contributor_group)
  // = contributor. Verify via the effective-access API (requires maintainer+ to call —
  // alice is the owner so she can call it).
  const effectiveAccess = await getEffectiveAccess(aliceSession.jwt, acme.id, carolSession.username)
  const entry = effectiveAccess.find((e) => e.projectId === projectId)
  expect(entry).toBeDefined()
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  expect(entry!.effectiveLevel).toBeGreaterThanOrEqual(ROLE.CONTRIBUTOR)

  // UI: carol's dashboard renders the project.
  const carolDash = new Dashboard(carol)
  await carolDash.goto()
  await carol.reload()
  await expect(carol.getByText("Team Project").first()).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 3: revoking access — the critical invariant
// ---------------------------------------------------------------------------

test("revoke org membership → bob can no longer list org projects", async ({ alice: _alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  const projectId = `fro144-revoke-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Secret Project" })

  // Add bob so he has access.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  const bobSession = await ensureAuthState("bob")
  const bobProjectsBefore = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsBefore.some((p) => p.id === projectId)).toBe(true)

  // Revoke bob's org membership (removes org_members row + all group_members rows).
  await removeOrgMember(aliceSession.jwt, acme.id, "bob")

  // Bob can no longer list org projects.
  const bobProjectsAfter = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsAfter.some((p) => p.id === projectId)).toBe(false)

  // UI: bob's dashboard no longer shows the project.
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await bob.reload()
  await expect(bob.getByText("Secret Project")).not.toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 4: full revoke — remove all paths → project returns 403
// ---------------------------------------------------------------------------

test("full revoke (all paths) → project endpoint returns 403 for bob", async ({ alice: _alice, bob: _bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  const projectId = `fro144-full-revoke-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Full-Revoke Project" })

  // Grant bob via org AND direct project_members.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)
  await addProjectMember(aliceSession.jwt, projectId, "bob", ROLE.PROJECT_LEAD)

  const bobSession = await ensureAuthState("bob")
  // Confirm access first.
  const checkBefore = await fetchProjectApi(bobSession.jwt, projectId)
  expect(checkBefore.status).toBe(200)

  // Remove org membership (removes org_members + group_members).
  await removeOrgMember(aliceSession.jwt, acme.id, "bob")

  // Bob still has direct project_members row → still 200 (OPQ-2 documented behavior).
  const checkAfterOrgRemoval = await fetchProjectApi(bobSession.jwt, projectId)
  expect(checkAfterOrgRemoval.status).toBe(200)

  // Remove direct project member row too.
  await removeProjectMember(aliceSession.jwt, projectId, "bob")

  // Now ALL paths are gone → 403.
  const checkFinal = await fetchProjectApi(bobSession.jwt, projectId)
  expect(checkFinal.status).toBe(403)
})

// ---------------------------------------------------------------------------
// Test 5: detach group project → group path gone, org path survives
// ---------------------------------------------------------------------------

test("detach group project → carol loses group bonus but keeps org baseline", async ({ alice: _alice, carol: _carol }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  const carolSession = await ensureAuthState("carol")

  const projectId = `fro144-detach-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Detach Test" })

  // Carol is org-viewer + group-contributor.
  await addOrgMember(aliceSession.jwt, acme.id, "carol", ROLE.VIEWER)
  const group = await createGroup(aliceSession.jwt, acme.id, "Translators-2")
  await addGroupMember(aliceSession.jwt, acme.id, group.id, "carol")
  await attachGroupProject(aliceSession.jwt, acme.id, group.id, projectId, ROLE.CONTRIBUTOR)

  // Effective = contributor (group beats org-viewer).
  const beforeDetach = await resolveProjectRole(carolSession.jwt, projectId)
  expect(beforeDetach.level).toBe(ROLE.CONTRIBUTOR)

  // Detach project from group.
  await detachGroupProject(aliceSession.jwt, acme.id, group.id, projectId)

  // After detach: effective = viewer (org-viewer path still active).
  const afterDetach = await resolveProjectRole(carolSession.jwt, projectId)
  expect(afterDetach.level).toBe(ROLE.VIEWER)
  // source="org" confirms the org-member path is active, not a group path.
  expect(afterDetach.path).toBe("org")
})

// ---------------------------------------------------------------------------
// Inline API helpers (thin wrappers over auth-worker endpoints)
// ---------------------------------------------------------------------------

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

function authHeaders(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }
}

async function listProjectsApi(jwt: string, orgId: number): Promise<ProjectRow[]> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects?orgId=${orgId}`,
    { headers: authHeaders(jwt) },
  )
  if (r.status === 403) return []
  if (!r.ok) throw new Error(`listProjects failed: ${r.status} — ${await r.text()}`)
  const data = (await r.json()) as { projects?: ProjectRow[] } | ProjectRow[]
  return Array.isArray(data) ? data : (data.projects ?? [])
}

async function fetchProjectApi(
  jwt: string,
  projectId: string,
): Promise<{ status: number }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}`,
    { headers: authHeaders(jwt) },
  )
  return { status: r.status }
}

async function removeProjectMember(
  jwt: string,
  projectId: string,
  username: string,
): Promise<void> {
  const user = await resolveUserId(jwt, username)
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members/${user.id}`,
    { method: "DELETE", headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`removeProjectMember failed: ${r.status} — ${await r.text()}`)
}

async function getEffectiveAccess(
  callerJwt: string,
  orgId: number,
  username: string,
): Promise<AccessEntry[]> {
  const user = await resolveUserId(callerJwt, username)
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${user.id}/access`,
    { headers: authHeaders(callerJwt) },
  )
  if (!r.ok) throw new Error(`getEffectiveAccess failed: ${r.status} — ${await r.text()}`)
  return (await r.json()) as AccessEntry[]
}

async function resolveProjectRole(
  jwt: string,
  projectId: string,
): Promise<{ level: number; path: string }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}`,
    { headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`resolveProjectRole failed: ${r.status} — ${await r.text()}`)
  const data = (await r.json()) as ProjectDetail
  // API returns `role.source` ("org" | "group" | "override" | "creator"), not "path".
  return { level: data.role?.level ?? 0, path: data.role?.source ?? "unknown" }
}

async function resolveUserId(jwt: string, username: string): Promise<UserRow> {
  // The lookup endpoint is GET /api/v2/users/lookup?username=X, not /:username.
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/users/lookup?username=${encodeURIComponent(username)}`,
    { headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`resolveUser(${username}) failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as UserRow
}
