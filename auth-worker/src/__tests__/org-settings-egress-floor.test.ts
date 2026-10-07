// Tests for egressMinRole membership in PERMISSION_POLICY_KEYS (AQU-907).
//
// The generic policy-key loop already carries the validation logic (covered
// in depth by org-settings-export-floor.test.ts); what these tests pin down
// is that egressMinRole actually sits behind that loop — the org-wide Data
// egress surface hands out the whole corpus in one action, so a maintainer
// must never be able to widen who sees it, and garbage floors must be
// rejected rather than silently coerced to the OWNER default.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed() {
  await seedUser(1, "alice") // org owner
  await seedUser(2, "bob")   // org maintainer
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

async function patchSettings(
  jwt: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 0,
): Promise<Response> {
  return app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(jwt),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

describe("org-settings PATCH egressMinRole validation (AQU-907)", () => {
  it("403s when a maintainer (600) tries to open the egress surface", async () => {
    await seed()
    const maintainerJwt = await jwtFor("bob")
    const res = await patchSettings(maintainerJwt, { egressMinRole: 600 })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/egressMinRole/)
  })

  it("200s when an owner (700) opens egress to maintainers (600)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { egressMinRole: 600 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { egressMinRole: number } }
    expect(body.settings.egressMinRole).toBe(600)
  })

  it("400s when the floor is not a role ladder value (450)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { egressMinRole: 450 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/egressMinRole/)
  })

  it("passes an unchanged echo through a maintainer's unrelated settings write", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    expect((await patchSettings(ownerJwt, { egressMinRole: 600 })).status).toBe(200)
    // The client patch() is read-modify-write: bob's write echoes the floor
    // back unchanged. Gate on CHANGE, not presence, or setting a floor locks
    // maintainers out of ALL org-settings writes (same invariant as
    // exportMinRole).
    const maintainerJwt = await jwtFor("bob")
    const res = await patchSettings(maintainerJwt, { egressMinRole: 600, rules: [] }, 1)
    expect(res.status).toBe(200)
  })
})
