import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-696: the list endpoint exposes when the caller was granted access to each
// project, so the client can badge newly-shared projects as "New". It must be
// present for shared projects (direct OR group grant) and absent for the
// caller's own projects.
describe("GET /api/v2/projects grant timestamp (AQU-696)", () => {
  it("returns grantedAt for a directly-shared project (cross-org invitee)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1), (2, 'Bob Org', 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 2, 700, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Shared', 1, 1)",
    ).run()
    // Bob (in another org) is invited to p1 directly, with a known grant time.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at) VALUES ('p1', 2, 400, 1, '2026-07-24T12:00:00Z')",
    ).run()

    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("bob")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; grantedAt: string | null }> }
    const p1 = body.projects.find((p) => p.id === "p1")
    expect(p1).toBeTruthy()
    expect(p1?.grantedAt).toBeTruthy()
    expect(Date.parse(p1!.grantedAt!)).toBe(Date.parse("2026-07-24T12:00:00Z"))
  })

  it("returns grantedAt for a group-granted project with no direct membership row", async () => {
    await seedUser(1, "alice")
    await seedUser(3, "carol")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1), (3, 'Carol Org', 3)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (3, 3, 700, 3)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p9', 'Group Shared', 1, 1)",
    ).run()
    // A group in Alice's org grants access to p9; Carol is a member of the group
    // but has no project_members row of her own for p9.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Reviewers', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id, added_by, added_at) VALUES (10, 3, 1, '2026-07-20T09:00:00Z')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, granted_at) VALUES (10, 'p9', 400, 1, '2026-07-22T15:00:00Z')",
    ).run()

    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("carol")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; grantedAt: string | null }> }
    const p9 = body.projects.find((p) => p.id === "p9")
    expect(p9).toBeTruthy()
    // Not null despite no project_members row — coalesced from the group grant.
    expect(p9?.grantedAt).toBeTruthy()
    expect(Date.parse(p9!.grantedAt!)).toBe(Date.parse("2026-07-22T15:00:00Z"))
  })

  it("returns null grantedAt for the caller's own (creator) project", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pown', 'Mine', 1, 1)",
    ).run()

    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("alice")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; grantedAt: string | null }> }
    const pown = body.projects.find((p) => p.id === "pown")
    expect(pown).toBeTruthy()
    expect(pown?.grantedAt ?? null).toBeNull()
  })
})
