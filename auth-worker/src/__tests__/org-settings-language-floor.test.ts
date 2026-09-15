// Tests for languageEditMinRole validation in the org-settings PATCH route
// (AQU-1086). Mirrors org-settings-termbase-floor.test.ts — same
// PERMISSION_POLICY_KEYS loop, so the key inherits role-ladder validation and
// the OWNER-only write gate.
//
// Verifies:
//   1. An org owner (700) can lower the floor to project lead (500).
//   2. A maintainer (600) trying to CHANGE it -> 403 (owner-only key).
//   3. A maintainer echoing the unchanged value still writes (the
//      read-modify-write client must not be locked out of all settings).
//   4. A garbage value (450 / "project_lead") -> 400.
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

describe("org-settings PATCH languageEditMinRole validation (AQU-1086)", () => {
  it("lets an owner (700) lower the floor to project lead (500)", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("alice"), { languageEditMinRole: 500 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { languageEditMinRole?: number } }
    expect(body.settings.languageEditMinRole).toBe(500)
  })

  it("403s when a maintainer (600) tries to change the floor", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("bob"), { languageEditMinRole: 500 })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/owner/)
    expect(body.error).toMatch(/languageEditMinRole/)
  })

  it("lets a maintainer echo the unchanged floor (read-modify-write client)", async () => {
    await seed('{"languageEditMinRole":500}')
    const res = await patchSettings(await jwtFor("bob"), {
      languageEditMinRole: 500,
      rules: [],
    })
    expect(res.status).toBe(200)
  })

  it("400s on a value that is not a role-ladder level", async () => {
    await seed()
    const jwt = await jwtFor("alice")
    const offLadder = await patchSettings(jwt, { languageEditMinRole: 450 })
    expect(offLadder.status).toBe(400)

    const notANumber = await patchSettings(jwt, { languageEditMinRole: "project_lead" })
    expect(notANumber.status).toBe(400)
    const body = (await notANumber.json()) as { error: string }
    expect(body.error).toMatch(/languageEditMinRole/)
  })
})
