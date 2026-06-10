// FRO-268 — Characterization tests: freeze role-resolution max-wins semantics
// and known membership-endpoint privilege quirks.
//
// Covers:
//   1. Role resolution: AD-12 max-wins across override / group / org / creator paths
//      (project-permissions.ts:103-186)
//   2. CHARACTERIZATION (audit F-B6): project_lead can demote a peer via the
//      add-member upsert (projects.ts:598-621) — FRO-285 will flip this.
//   3. CHARACTERIZATION (audit F-B6): maintainer can delete an owner's project_members
//      row (projects.ts:647-669) — FRO-285 will flip this.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// ─── Shared seed helpers ──────────────────────────────────────────────────────

async function seedBase() {
  // users: 1=owner, 2=project_lead, 3=maintainer, 4=owner_member
  await seedUser(1, "owner")
  await seedUser(2, "project_lead_user")
  await seedUser(3, "maintainer_user")
  await seedUser(4, "owner_member")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  // Owner is org-member at 700
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  // Project created by owner (creator path → 700)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-role', 'RoleProject', 1, 1)",
  ).run()
}

// ─── Suite 1: Max-wins — five paths ───────────────────────────────────────────

describe("AD-12 max-wins role resolution (project-permissions.ts:103-186)", () => {
  it("creator path grants 700 when no org or direct grant exists for the creator", async () => {
    // NOTE: seedBase() adds owner to org_members(700). The sort is max-wins,
    // with tie-breaking by declaration order (override > group > org > creator).
    // When the creator is ALSO an org member at 700, "org" beats "creator" in
    // the tie-break (sourcePriority org=2 > creator=1).
    // To isolate the creator path, create a project by a user who has NO
    // org_members row.
    await seedBase()
    await seedUser(9, "sole_creator")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-creator-only', 'CreatorOnly', 1, 9)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-creator-only",
      { headers: authHeader(await jwtFor("sole_creator")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role.level).toBe(700)
    expect(body.role.source).toBe("creator")
  })

  it("when creator is ALSO an org member at 700, source=org wins the tie-break (org priority > creator priority)", async () => {
    // This is the tie-breaking declaration order: org(2) > creator(1)
    // Both contribute level=700; the sort picks org as the winner.
    await seedBase()
    // owner(user 1) is both created_by=1 and in org_members(700)
    const res = await app.request(
      "/api/v2/projects/proj-role",
      { headers: authHeader(await jwtFor("owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role.level).toBe(700)
    // CHARACTERIZATION: org wins the tie-break, not creator
    expect(body.role.source).toBe("org")
  })

  it("direct override beats org path when override is higher", async () => {
    await seedBase()
    // org path at 100, override at 400
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 2, 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-role",
      { headers: authHeader(await jwtFor("project_lead_user")) },
      env,
    )
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role.level).toBe(400)
    expect(body.role.source).toBe("override")
  })

  it("org path beats lower direct override (higher wins)", async () => {
    await seedBase()
    // org at 400, override at 100
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 2, 100, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-role",
      { headers: authHeader(await jwtFor("project_lead_user")) },
      env,
    )
    const body = (await res.json()) as { role: { level: number; source: string } }
    // org(400) beats override(100)
    expect(body.role.level).toBe(400)
    expect(body.role.source).toBe("org")
  })

  it("group path beats org path when group grant is higher", async () => {
    await seedBase()
    // org at 100, group at 500
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Translators', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (10, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj-role', 500, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-role",
      { headers: authHeader(await jwtFor("project_lead_user")) },
      env,
    )
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role.level).toBe(500)
    expect(body.role.source).toBe("group")
  })

  it("direct override (500) beats group (300) at same level, source=override wins by declaration order", async () => {
    await seedBase()
    // Both at 500 — override declared first in sourcePriority, so it wins attribution
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'G', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (10, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj-role', 500, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 2, 500, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-role",
      { headers: authHeader(await jwtFor("project_lead_user")) },
      env,
    )
    const body = (await res.json()) as { role: { level: number; source: string } }
    // Tie at 500 — declaration order: override > group > org > creator > platform
    expect(body.role.level).toBe(500)
    expect(body.role.source).toBe("override")
  })

  it("outsider with no grant path gets 403", async () => {
    await seedBase()
    await seedUser(5, "outsider")
    const res = await app.request(
      "/api/v2/projects/proj-role",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})

// ─── Suite 2: Membership endpoint privilege quirks ────────────────────────────

describe("CHARACTERIZATION (audit F-B6): membership endpoint privilege holes — FRO-285 will flip this", () => {
  async function seedForMembershipTests() {
    await seedBase()
    // peer_lead: a project_lead(500) who is NOT the creator
    await seedUser(5, "peer_lead")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 2, 500, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 5, 500, 1)",
    ).run()
    // maintainer user
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 3, 600, 1)",
    ).run()
    // owner_member (700) via direct project_members row
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 4, 700, 1)",
    ).run()
  }

  // CHARACTERIZATION (audit F-B6): intentionally frozen wrong behavior;
  // FRO-285 will flip this — project_lead should NOT be able to demote a peer
  // project_lead via the add-member upsert.
  it("project_lead(500) can upsert-demote a peer project_lead(500) to viewer(100)", async () => {
    await seedForMembershipTests()

    // project_lead_user(500) calls POST /members to set peer_lead(500) → viewer(100)
    // The route only checks `role > callerRole.level`; demoting a 500 peer to 100 passes
    // because 100 is NOT > 500.
    const res = await app.request(
      "/api/v2/projects/proj-role/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ username: "peer_lead", role: 100 }),
      },
      env,
    )
    // CHARACTERIZATION: must be 200 today (the bug). When FRO-285 flips this,
    // the response should be 403 (cannot demote a peer of equal role).
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number } }
    expect(body.role.level).toBe(100)

    // Confirm the DB row was actually changed
    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'proj-role' AND user_id = 5",
    ).first<{ role_level: number }>()
    expect(Number(row?.role_level)).toBe(100)
  })

  // CHARACTERIZATION (audit F-B6): intentionally frozen wrong behavior;
  // FRO-285 will flip this — maintainer should NOT be able to delete the
  // project_members row of an owner-level user.
  it("maintainer(600) can DELETE the project_members row of an owner(700)", async () => {
    await seedForMembershipTests()

    // maintainer_user(600) deletes owner_member's(700) row
    // The DELETE route checks callerRole >= 600 then deletes without checking target level
    const res = await app.request(
      "/api/v2/projects/proj-role/members/4",
      {
        method: "DELETE",
        headers: authHeader(await jwtFor("maintainer_user")),
      },
      env,
    )
    // CHARACTERIZATION: must be 200 today (the bug). When FRO-285 flips this,
    // the response should be 403 (cannot remove a member with role >= caller's role).
    expect(res.status).toBe(200)

    // Confirm the row is gone
    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM project_members WHERE project_id = 'proj-role' AND user_id = 4",
    ).first()
    expect(row).toBeNull()
  })

  // Correct behavior preserved: a user CANNOT grant higher than their own role
  it("project_lead(500) cannot promote anyone above their own role level", async () => {
    await seedForMembershipTests()

    const res = await app.request(
      "/api/v2/projects/proj-role/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ username: "peer_lead", role: 600 }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  // Correct behavior preserved: maintainer(600) cannot DELETE their own row
  // (self-remove is rejected by the "cannot grant role to self" path in POST,
  // but self-DELETE is a separate behavior — confirm it fails gracefully)
  it("contributor(400) cannot call the DELETE members endpoint (requires maintainer+)", async () => {
    await seedBase()
    await seedUser(6, "contributor_user")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 6, 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-role/members/6",
      {
        method: "DELETE",
        headers: authHeader(await jwtFor("contributor_user")),
      },
      env,
    )
    expect(res.status).toBe(403)
  })
})
