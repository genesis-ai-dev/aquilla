// /migrate/org-team-maps returns the org + team placement maps the content
// migration needs, read from NEON (the live datastore) — replacing the old
// `wrangler d1 execute aquilla-db` reads that became stale after the D1→Neon
// cutover. Keyed by legacy_uuid (the stable GitLab-group-derived id).
import { describe, it, expect, afterAll } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { handleMigrateOrgTeamMapsRequest } from "../events/migrate-org-team-maps-route"

const SECRET = "maps-secret"
const req = (auth = `Bearer ${SECRET}`) =>
  new Request("https://sync.example/migrate/org-team-maps", { headers: { Authorization: auth } })

let t: TestDb
afterAll(async () => {
  await t?.close()
})

describe("handleMigrateOrgTeamMapsRequest", () => {
  it("returns orgs + groups from Neon, keyed by legacy_uuid, excluding null legacy_uuid", async () => {
    t = await makeTestDb({
      organizations: [
        { id: 10, legacy_uuid: "org-a", owner_user_id: 5, name: "A" },
        { id: 11, legacy_uuid: "org-b", owner_user_id: 6, name: "B" },
        { id: 12, legacy_uuid: null, owner_user_id: 7, name: "native-no-legacy" },
      ],
      groups: [
        { id: 100, legacy_uuid: "grp-x", org_id: 10, name: "X" },
        { id: 101, legacy_uuid: null, org_id: 10, name: "native-team" },
      ],
    })

    const res = await handleMigrateOrgTeamMapsRequest(req(), {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as {
      orgs: { legacyUuid: string; id: number; ownerUserId: number }[]
      groups: { legacyUuid: string; id: number }[]
    }
    expect(body.orgs).toContainEqual({ legacyUuid: "org-a", id: 10, ownerUserId: 5 })
    expect(body.orgs).toContainEqual({ legacyUuid: "org-b", id: 11, ownerUserId: 6 })
    expect(body.orgs).toHaveLength(2) // org-12 (null legacy_uuid) excluded
    expect(body.groups).toContainEqual({ legacyUuid: "grp-x", id: 100 })
    expect(body.groups).toHaveLength(1) // group-101 (null legacy_uuid) excluded
  })

  it("rejects a wrong secret", async () => {
    const res = await handleMigrateOrgTeamMapsRequest(req("Bearer nope"), {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res?.status).toBe(401)
  })

  it("returns null for non-matching paths", async () => {
    const res = await handleMigrateOrgTeamMapsRequest(
      new Request("https://sync.example/elsewhere"),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res).toBeNull()
  })
})
