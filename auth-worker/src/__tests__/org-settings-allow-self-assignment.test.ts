// Tests for allowSelfAssignment validation in the org-settings PATCH route
// (AQU-496). Mirrors org-settings-export-floor.test.ts's structure — same
// PERMISSION_POLICY_KEYS loop, but this key is a boolean rather than a
// role-ladder number.
//
// Verifies:
//   1. A non-boolean value (string, number) -> 400 with a clear message.
//   2. A maintainer (600) trying to set allowSelfAssignment -> 403 (owner-only key).
//   3. An owner (700) setting allowSelfAssignment=true -> 200.
//   4. An owner setting allowSelfAssignment=false (explicit) -> 200.
//   5. An unchanged echo of the current value doesn't trip the owner-only gate.
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

describe("org-settings PATCH allowSelfAssignment validation (AQU-496)", () => {
  it("400s when allowSelfAssignment is a string ('true')", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { allowSelfAssignment: "true" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/allowSelfAssignment/)
  })

  it("400s when allowSelfAssignment is a number (1)", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { allowSelfAssignment: 1 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/allowSelfAssignment/)
  })

  it("403s when a maintainer (600) tries to set allowSelfAssignment", async () => {
    await seed()
    const maintainerJwt = await jwtFor("bob")
    const res = await patchSettings(maintainerJwt, { allowSelfAssignment: true })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/owner/)
  })

  it("200s when an owner (700) sets allowSelfAssignment to true", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { allowSelfAssignment: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings.allowSelfAssignment).toBe(true)
  })

  it("200s when an owner explicitly sets allowSelfAssignment to false", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const res = await patchSettings(ownerJwt, { allowSelfAssignment: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings.allowSelfAssignment).toBe(false)
  })

  it("200s for a non-allowSelfAssignment settings write by a maintainer", async () => {
    await seed()
    const maintainerJwt = await jwtFor("bob")
    const res = await patchSettings(maintainerJwt, { someOtherKey: "value" })
    expect(res.status).toBe(200)
  })

  it("a maintainer echoing back the unchanged current value does not trip the owner-only gate", async () => {
    await seed()
    const ownerJwt = await jwtFor("alice")
    const maintainerJwt = await jwtFor("bob")
    // Owner turns it on first.
    const first = await patchSettings(ownerJwt, { allowSelfAssignment: true })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { version: number }
    // Whole-object read-modify-write pattern: a maintainer's subsequent
    // settings write echoes the unchanged allowSelfAssignment=true back —
    // gate on CHANGE, not presence (same invariant as exportMinRole).
    const second = await patchSettings(
      maintainerJwt,
      { allowSelfAssignment: true, someOtherKey: "value" },
      firstBody.version,
    )
    expect(second.status).toBe(200)
  })
})
