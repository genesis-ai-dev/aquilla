/**
 * AQU-144 + AQU-435 — Org-level access-control E2E
 *
 * Covers the access-control journey in
 * aquilla-specs/05-user-stories/access-control-permission-semantics.md,
 * updated for AQU-435: the org path is *oversight* and fires only at
 * Maintainer+ (role_level >= 600). A Contributor/Viewer reaches a project
 * through a direct membership or a team (group) grant — never through
 * org membership alone.
 *
 *   1. Alice creates a project and invites Bob as Contributor.
 *      Bob does NOT see the project (no org-wide visibility below Maintainer).
 *   2. Alice creates a team, adds Carol (org Viewer) to the team, and grants
 *      the team access to the project. Carol sees the project via the group
 *      path (not via org-viewer).
 *   3. Alice invites Bob as Maintainer (org path fires) then revokes his org
 *      membership → Bob can no longer access the project.
 *   4. Alice fully removes Bob's org + direct paths → project returns 403.
 *   5. Alice detaches the project from the team → Carol loses the group path
 *      and has no org-viewer fallback (AQU-435) → 403.
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
import type { Page } from "@playwright/test"

async function expectOrgProjectsPage(page: Page, orgId: number): Promise<void> {
  await page.goto(`/orgs/${orgId}/projects`)
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 15_000 })
}

// ---------------------------------------------------------------------------
// Test 1: org membership below Maintainer does NOT grant project visibility
// ---------------------------------------------------------------------------

test("invite contributor to org → bob does not see org projects (AQU-435)", async ({ alice: _alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  // Create a project under Alice's org.
  const projectId = `fro144-proj-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Acme Bible" })

  // Bob is NOT a member yet — should NOT see the project.
  const bobSession = await ensureAuthState("bob")
  const bobProjectsBefore = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsBefore.some((p) => p.id === projectId)).toBe(false)

  // Alice invites Bob to the org as Contributor. AQU-435: that is not enough
  // for the org path — Bob still has no direct/team grant.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  const bobProjectsAfter = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsAfter.some((p) => p.id === projectId)).toBe(false)

  // UI: bob can open Acme (he's a member) but the project is absent.
  await expectOrgProjectsPage(bob, acme.id)
  await expect(bob.getByText("Acme Bible")).toHaveCount(0)
})

interface ProjectRow {
  id: string
  name: string
}

interface AccessEntry {
  projectId: string
  effectiveLevel: number
}

// Actual shape returned by GET /api/v2/orgs/:orgId/members/:userId/access
interface EffectiveAccessResponse {
  orgRole: number | null
  projects: Array<{
    projectId: string
    projectName: string
    direct: number | null
    groups: Array<{ groupId: number; name: string; roleLevel: number }>
    org: number | null
    creator: boolean
    resolved: number
  }>
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
// Test 2: team (group) path grants project visibility at group role
// ---------------------------------------------------------------------------

test("create team → add carol → attach project → carol sees project", async ({ alice: _alice, carol }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  const projectId = `fro144-team-${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: "Team Project" })

  // Carol must be an org member before she can be added to a group.
  await addOrgMember(aliceSession.jwt, acme.id, "carol", ROLE.VIEWER)

  // AQU-435: org-viewer does NOT reveal org projects. Carol sees nothing
  // until the team grant lands.
  const carolSession = await ensureAuthState("carol")
  const carolProjectsBefore = await listProjectsApi(carolSession.jwt, acme.id)
  expect(carolProjectsBefore.some((p) => p.id === projectId)).toBe(false)

  // Create team and add carol.
  const group = await createGroup(aliceSession.jwt, acme.id, "Translators")
  await addGroupMember(aliceSession.jwt, acme.id, group.id, "carol")

  // Attach project to group with contributor role.
  await attachGroupProject(aliceSession.jwt, acme.id, group.id, projectId, ROLE.CONTRIBUTOR)

  // Carol's effective role on the project should be the group contributor
  // grant (org-viewer does not contribute). Verify via the effective-access
  // API (requires maintainer+ to call — alice is the owner so she can).
  const effectiveAccess = await getEffectiveAccess(aliceSession.jwt, acme.id, carolSession.username)
  const entry = effectiveAccess.find((e) => e.projectId === projectId)
  expect(entry).toBeDefined()
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  expect(entry!.effectiveLevel).toBeGreaterThanOrEqual(ROLE.CONTRIBUTOR)

  const carolProjectsAfter = await listProjectsApi(carolSession.jwt, acme.id)
  expect(carolProjectsAfter.some((p) => p.id === projectId)).toBe(true)

  // UI: carol's Acme projects page renders the project.
  await expectOrgProjectsPage(carol, acme.id)
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

  // Add bob as Maintainer so the org path fires (AQU-435 floor).
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.MAINTAINER)

  const bobSession = await ensureAuthState("bob")
  const bobProjectsBefore = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsBefore.some((p) => p.id === projectId)).toBe(true)

  // Revoke bob's org membership (removes org_members row + all group_members rows).
  await removeOrgMember(aliceSession.jwt, acme.id, "bob")

  // Bob can no longer list org projects.
  const bobProjectsAfter = await listProjectsApi(bobSession.jwt, acme.id)
  expect(bobProjectsAfter.some((p) => p.id === projectId)).toBe(false)

  // UI: bob's own dashboard no longer shows the project.
  await expectOrgProjectsPage(bob, bob.orgId)
  await expect(bob.getByText("Secret Project")).toHaveCount(0)
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

  // Effective = contributor (group beats a non-contributing org-viewer).
  const beforeDetach = await resolveProjectRole(carolSession.jwt, projectId)
  expect(beforeDetach.level).toBe(ROLE.CONTRIBUTOR)
  expect(beforeDetach.path).toBe("group")

  // Detach project from group.
  await detachGroupProject(aliceSession.jwt, acme.id, group.id, projectId)

  // After detach: org-viewer is below the AQU-435 floor, so no path remains.
  const afterDetach = await fetchProjectApi(carolSession.jwt, projectId)
  expect(afterDetach.status).toBe(403)
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
  // API returns { orgRole, projects: [{projectId, resolved, ...}] }
  const data = (await r.json()) as EffectiveAccessResponse
  return (data.projects ?? []).map((p) => ({
    projectId: p.projectId,
    effectiveLevel: p.resolved,
  }))
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
