// Tests for exportMinRole validation in the org-settings PATCH route (AQU-253).
//
// Verifies:
//   1. Garbage values (string, out-of-range, NaN) → 400 with a clear message.
//   2. A maintainer (600) trying to set exportMinRole → 403 (owner-only key).
//   3. An owner (700) setting a valid exportMinRole → 200.
//   4. An owner setting an invalid exportMinRole → 400.
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
  // Seed an org_settings row so PATCH always sees an existing row (version=0).
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

describe("org-settings PATCH exportMinRole validation (AQU-253)", () => {
  it("400s when exportMinRole is a string ('owner')", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { exportMinRole: "owner" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/exportMinRole/)
  })

  it("400s when exportMinRole is out of range (9999)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { exportMinRole: 9999 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/exportMinRole/)
  })

  it("400s when exportMinRole is negative (-1)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { exportMinRole: -1 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/exportMinRole/)
  })

  it("403s when a maintainer (600) tries to set exportMinRole", async () => {
    await seed()
    const maintainerJwt = await jwtFor("bob")
    const res = await patchSettings(maintainerJwt, { exportMinRole: 400 })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/owner/)
  })

  it("200s when an owner (700) sets exportMinRole to a valid value (400)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { exportMinRole: 400 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings.exportMinRole).toBe(400)
  })

  it("200s when an owner sets exportMinRole to OWNER (700 — most restrictive)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { exportMinRole: 700 })
    expect(res.status).toBe(200)
  })

  it("200s for a non-exportMinRole settings write by a maintainer", async () => {
    await seed()
    const maintainerJwt = await jwtFor("bob")
    const res = await patchSettings(maintainerJwt, { someOtherKey: "value" })
    expect(res.status).toBe(200)
  })
})
