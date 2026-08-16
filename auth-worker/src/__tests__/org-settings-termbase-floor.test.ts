// Tests for termbaseEditMinRole validation in the org-settings PATCH route
// (AQU-822). Mirrors org-settings-export-floor.test.ts — same
// PERMISSION_POLICY_KEYS loop, so the key inherits role-ladder validation and
// the OWNER-only write gate.
//
// Verifies:
//   1. An org owner (700) can set the floor to contributor (400).
//   2. A maintainer (600) trying to CHANGE it -> 403 (owner-only key).
//   3. A maintainer echoing the unchanged value still writes (the
//      read-modify-write client must not be locked out of all settings).
//   4. A garbage value (450 / "contributor") -> 400.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed(initialSettings = "{}") {
  await seedUser(1, "alice") // org owner
  await seedUser(2, "bob") // org maintainer
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)",
  )
    .bind(initialSettings)
    .run()
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

describe("org-settings PATCH termbaseEditMinRole validation (AQU-822)", () => {
  it("lets an owner (700) lower the floor to contributor (400)", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("alice"), { termbaseEditMinRole: 400 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { termbaseEditMinRole?: number } }
    expect(body.settings.termbaseEditMinRole).toBe(400)
  })

  it("403s when a maintainer (600) tries to change the floor", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("bob"), { termbaseEditMinRole: 400 })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/owner/)
    expect(body.error).toMatch(/termbaseEditMinRole/)
  })

  it("lets a maintainer echo the unchanged floor (read-modify-write client)", async () => {
    await seed('{"termbaseEditMinRole":400}')
    const res = await patchSettings(await jwtFor("bob"), {
      termbaseEditMinRole: 400,
      rules: [],
    })
    expect(res.status).toBe(200)
  })

  it("400s on a value that is not a role-ladder level", async () => {
    await seed()
    const jwt = await jwtFor("alice")
    const offLadder = await patchSettings(jwt, { termbaseEditMinRole: 450 })
    expect(offLadder.status).toBe(400)

    const notANumber = await patchSettings(jwt, { termbaseEditMinRole: "contributor" })
    expect(notANumber.status).toBe(400)
    const body = (await notANumber.json()) as { error: string }
    expect(body.error).toMatch(/termbaseEditMinRole/)
  })
})
