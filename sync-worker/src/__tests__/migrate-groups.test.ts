// POST /migrate/groups upserts the org/team structure (orgs, org_members, teams,
// group_members) into NEON from a GroupImportPlan — completing the D1→Neon
// cutover so a content delta can fully pull in NEW orgs. Idempotent (ON CONFLICT
// DO NOTHING on legacy_uuid + member PKs); returns legacy_uuid→id maps.
import { describe, it, expect, afterAll } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { handleMigrateGroupsRequest } from "../events/migrate-groups-route"

const SECRET = "groups-secret"
function post(plan: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request("https://sync.example/migrate/groups", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  })
}

const PLAN = {
  orgs: [{ legacyUuid: "org-a", gitlabId: 1, name: "Org A", ownerUserId: 5 }],
  orgMembers: [
    { orgUuid: "org-a", userId: 5, roleLevel: 3 },
    { orgUuid: "org-a", userId: 6, roleLevel: 1 },
  ],
  teams: [{ legacyUuid: "grp-x", orgUuid: "org-a", gitlabId: 10, name: "Team X", createdBy: 5 }],
  teamMembers: [{ teamUuid: "grp-x", userId: 6 }],
  conflicts: [],
}

let t: TestDb
afterAll(async () => {
  await t?.close()
})

describe("handleMigrateGroupsRequest", () => {
  it("creates org + members + team + team members in Neon and returns id maps", async () => {
    t = await makeTestDb({
      users: [
        { id: 5, username: "owner", email: "owner@x.io" },
        { id: 6, username: "member", email: "member@x.io" },
      ],
    })
    const res = await handleMigrateGroupsRequest(post(PLAN), { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as {
      orgIdByUuid: Record<string, number>
      teamIdByUuid: Record<string, number>
      created: { orgs: number; orgMembers: number; teams: number; teamMembers: number }
    }
    const orgId = body.orgIdByUuid["org-a"]
    const teamId = body.teamIdByUuid["grp-x"]
    expect(orgId).toBeGreaterThan(0)
    expect(teamId).toBeGreaterThan(0)

    const orgs = await t.rows<{ name: string; owner_user_id: number; legacy_uuid: string }>("organizations")
    expect(orgs).toEqual([{ ...orgs[0], name: "Org A", owner_user_id: 5, legacy_uuid: "org-a" }])
    expect((await t.rows("org_members")).length).toBe(2)
    const groups = await t.rows<{ org_id: number; legacy_uuid: string; created_by: number }>("groups")
    expect(groups).toEqual([{ ...groups[0], org_id: orgId, legacy_uuid: "grp-x", created_by: 5 }])
    expect((await t.rows("group_members")).length).toBe(1)
  })

  it("is idempotent — re-applying the same plan creates nothing new, returns the same ids", async () => {
    const first = (await (await handleMigrateGroupsRequest(post(PLAN), {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    }))!.json()) as { orgIdByUuid: Record<string, number>; created: { orgs: number } }
    expect(first.created.orgs).toBe(0) // already exists
    expect(first.orgIdByUuid["org-a"]).toBeGreaterThan(0)
    expect((await t.rows("organizations")).length).toBe(1)
    expect((await t.rows("org_members")).length).toBe(2)
    expect((await t.rows("groups")).length).toBe(1)
  })

  it("rejects a wrong secret + ignores other paths", async () => {
    expect((await handleMigrateGroupsRequest(post(PLAN, "Bearer no"), { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }))?.status).toBe(401)
    expect(
      await handleMigrateGroupsRequest(new Request("https://sync.example/other", { method: "POST" }), {
        AQUILLA_PG: t.db,
        SYNC_SECRET_KEY: SECRET,
      }),
    ).toBeNull()
  })
})
