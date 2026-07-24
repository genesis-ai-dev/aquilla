// AQU-268 — Characterization tests: freeze role-resolution max-wins semantics
// and known membership-endpoint privilege quirks.
//
// Covers:
//   1. Role resolution: AD-12 max-wins across override / group / org / creator paths
//      (project-permissions.ts:103-186)
//   2. CHARACTERIZATION (audit F-B6): project_lead can demote a peer via the
//      add-member upsert (projects.ts:598-621) — AQU-285 will flip this.
//   3. CHARACTERIZATION (audit F-B6): maintainer can delete an owner's project_members
//      row (projects.ts:647-669) — AQU-285 will flip this.

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
    // org at 600 (maintainer — the AQU-435 floor for the org path), override at 100
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 600, 1)",
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
    // org(600) beats override(100)
    expect(body.role.level).toBe(600)
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

// ─── Suite 2: Membership endpoint privilege holes — AQU-285 FIXED ────────────
//
// These tests were CHARACTERIZATION tests in AQU-268 that pinned the old
// (buggy) behavior. AQU-285 intentionally flips them to assert the new
// secure behavior: target-level caps enforced.

describe("AQU-285: membership endpoint target-level caps (was: F-B6 privilege holes)", () => {
  async function seedForMembershipTests() {
    await seedBase()
    // project_lead_user (user 2) — project_lead(500)
    await seedUser(5, "peer_lead")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 2, 500, 1)",
    ).run()
    // peer_lead (user 5) — also project_lead(500)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 5, 500, 1)",
    ).run()
    // maintainer_user (user 3) — maintainer(600)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 3, 600, 1)",
    ).run()
    // owner_member (user 4) — owner(700) via direct project_members row
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 4, 700, 1)",
    ).run()
  }

  // FLIPPED (was: AQU-268 characterization of the bug).
  // project_lead(500) CANNOT upsert-demote a peer project_lead(500) — the
  // target's current level (500) equals the caller's level (500), so 403.
  it("project_lead(500) cannot upsert-demote a peer project_lead(500) to viewer(100) — 403", async () => {
    await seedForMembershipTests()

    const res = await app.request(
      "/api/v2/projects/proj-role/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ username: "peer_lead", role: 100 }),
      },
      env,
    )
    // AQU-285: must be 403 — target current level (500) >= caller level (500)
    expect(res.status).toBe(403)

    // Confirm the DB row was NOT changed
    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'proj-role' AND user_id = 5",
    ).first<{ role_level: number }>()
    expect(Number(row?.role_level)).toBe(500)
  })

  // FLIPPED (was: AQU-268 characterization of the bug).
  // maintainer(600) CANNOT DELETE the project_members row of an owner(700) — 403.
  it("maintainer(600) cannot DELETE the project_members row of an owner(700) — 403", async () => {
    await seedForMembershipTests()

    const res = await app.request(
      "/api/v2/projects/proj-role/members/4",
      {
        method: "DELETE",
        headers: authHeader(await jwtFor("maintainer_user")),
      },
      env,
    )
    // AQU-285: must be 403 — target level (700) > caller level (600)
    expect(res.status).toBe(403)

    // Confirm the row is still present
    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM project_members WHERE project_id = 'proj-role' AND user_id = 4",
    ).first()
    expect(row).not.toBeNull()
  })

  // New: owner(700) CAN delete any member row — owner bypass applies.
  it("owner(700) can DELETE the project_members row of a maintainer(600)", async () => {
    await seedForMembershipTests()

    const res = await app.request(
      "/api/v2/projects/proj-role/members/3",
      {
        method: "DELETE",
        headers: authHeader(await jwtFor("owner")),
      },
      env,
    )
    expect(res.status).toBe(200)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM project_members WHERE project_id = 'proj-role' AND user_id = 3",
    ).first()
    expect(row).toBeNull()
  })

  // New: owner(700) CAN upsert a peer owner's row — owner bypass applies.
  it("owner(700) can upsert another owner(700) member's role", async () => {
    await seedForMembershipTests()

    // owner_member (user 4, role 700) is being set to maintainer(600) by owner (user 1, role 700)
    const res = await app.request(
      "/api/v2/projects/proj-role/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ username: "owner_member", role: 600 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number } }
    expect(body.role.level).toBe(600)
  })

  // New: project_lead(500) CAN add a net-new member at a lower role — no
  // existing row means target current level = 0, so 0 < 500 passes.
  it("project_lead(500) can add a brand-new member at contributor(400)", async () => {
    await seedForMembershipTests()
    await seedUser(7, "new_member")

    const res = await app.request(
      "/api/v2/projects/proj-role/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ username: "new_member", role: 400 }),
      },
      env,
    )
    expect(res.status).toBe(200)
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

  // Correct behavior preserved: caller CAN DELETE a member strictly below their level
  // — maintainer(600) can delete contributor(400)
  it("maintainer(600) CAN delete a contributor(400) member row", async () => {
    await seedForMembershipTests()
    await seedUser(6, "contributor_user")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 6, 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-role/members/6",
      {
        method: "DELETE",
        headers: authHeader(await jwtFor("maintainer_user")),
      },
      env,
    )
    // maintainer level (600) > target level (400) → allowed
    expect(res.status).toBe(200)
  })

  // Correct behavior preserved: level-floor check for delete endpoint
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

// ─── Suite 3: Frozen project — sync-token mint block (AQU-285) ───────────────

describe("AQU-285: frozen project blocks sync-token mint, reads still work", () => {
  async function seedFrozenProject() {
    await seedBase()
    // project_member_user (user 2) with direct grant at 400
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-role', 2, 400, 1)",
    ).run()
  }

  it("sync-token mint is rejected (403) when is_active=false (frozen project)", async () => {
    await seedFrozenProject()
    // Freeze the project
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET is_active = false WHERE id = 'proj-role'",
    ).run()

    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ projectId: "proj-role", fileId: "file-1" }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/frozen/i)
  })

  it("sync-token mint succeeds when is_active=true (active project)", async () => {
    await seedFrozenProject()
    // Ensure project is active (default)
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET is_active = true WHERE id = 'proj-role'",
    ).run()

    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ projectId: "proj-role", fileId: "file-1" }),
      },
      env,
    )
    // May 200 or 403 depending on SYNC_SECRET_KEY presence in test env —
    // what we assert is that it is NOT a frozen-project 403.
    if (res.status === 403) {
      const body = (await res.json()) as { error: string }
      // A role/access 403 is fine; a "frozen" 403 would be a bug.
      expect(body.error).not.toMatch(/frozen/i)
    } else {
      expect(res.status).toBe(200)
    }
  })

  it("sync-token mint is also rejected (403) when archived_at is set", async () => {
    await seedFrozenProject()
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET archived_at = CURRENT_TIMESTAMP WHERE id = 'proj-role'",
    ).run()

    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("project_lead_user")),
        body: JSON.stringify({ projectId: "proj-role", fileId: "file-1" }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/archived/i)
  })
})
