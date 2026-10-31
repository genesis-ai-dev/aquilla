// Tests for importMinRole validation in the org-settings PATCH route
// (AQU-2304), and for the project settings response carrying the resolved
// floor. Mirrors org-settings-language-floor.test.ts — same
// PERMISSION_POLICY_KEYS loop, so the key inherits role-ladder validation and
// the OWNER-only write gate.
//
// Verifies:
//   1. An org owner (700) can raise the floor to maintainer (600).
//   2. A maintainer (600) trying to CHANGE it -> 403 (owner-only key).
//   3. A maintainer echoing the unchanged value still writes (the
//      read-modify-write client must not be locked out of all settings).
//   4. A garbage value (450 / "maintainer") -> 400.
//   5. The project's settings response carries the resolved floor, for a
//      project member who cannot read the org's settings at all — the whole
//      reason the floor rides that bundle rather than the org read.
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

describe("org-settings PATCH importMinRole validation (AQU-2304)", () => {
  it("lets an owner (700) raise the floor to maintainer (600)", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("alice"), { importMinRole: 600 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { importMinRole?: number } }
    expect(body.settings.importMinRole).toBe(600)
  })

  it("403s when a maintainer (600) tries to change the floor", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("bob"), { importMinRole: 600 })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/owner/)
    expect(body.error).toMatch(/importMinRole/)
  })

  it("lets a maintainer echo the unchanged floor (read-modify-write client)", async () => {
    await seed('{"importMinRole":600}')
    const res = await patchSettings(await jwtFor("bob"), {
      importMinRole: 600,
      rules: [],
    })
    expect(res.status).toBe(200)
  })

  it("carries a maintainer's omitted floor over instead of resetting it", async () => {
    // [Pen test 2026-10-06] the blob is replaced wholesale, so a maintainer
    // dropping the key must not silently hand imports back to every lead.
    await seed('{"importMinRole":600}')
    const res = await patchSettings(await jwtFor("bob"), { rules: [] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { importMinRole?: number } }
    expect(body.settings.importMinRole).toBe(600)
  })

  it("400s on a value that is not a role-ladder level", async () => {
    await seed()
    const jwt = await jwtFor("alice")
    const offLadder = await patchSettings(jwt, { importMinRole: 450 })
    expect(offLadder.status).toBe(400)

    const notANumber = await patchSettings(jwt, { importMinRole: "maintainer" })
    expect(notANumber.status).toBe(400)
    const body = (await notANumber.json()) as { error: string }
    expect(body.error).toMatch(/importMinRole/)
  })
})

describe("project settings response carries the import floor (AQU-2304)", () => {
  async function seedProject(orgSettings: Record<string, unknown>) {
    await seed(JSON.stringify(orgSettings))
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Proj', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('proj1', '{}', 1, 1)",
    ).run()
    // A PROJECT LEAD by direct grant who is NOT an org member: the case the
    // carried bundle exists for. The org settings route refuses them, so
    // without the carried value their browser would fall back to the built-in
    // PROJECT_LEAD default and offer an import the server refuses.
    await seedUser(6, "pat")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 6, 500, 1)",
    ).run()
  }

  const settingsFor = async (username: string) =>
    app.request(
      "/api/v2/projects/proj1/settings",
      { headers: authHeader(await jwtFor(username)) },
      env,
    )

  it("resolves the org's explicit floor for a member outside the org", async () => {
    await seedProject({ importMinRole: 600 })
    const orgRes = await app.request(
      "/api/v2/orgs/1/settings",
      { headers: authHeader(await jwtFor("pat")) },
      env,
    )
    expect(orgRes.status).toBe(403)

    const res = await settingsFor("pat")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orgPolicy: { importMinRole?: number } }
    expect(body.orgPolicy.importMinRole).toBe(600)
  })

  it("resolves the PROJECT_LEAD default when the org never set the key", async () => {
    await seedProject({})
    const body = (await (await settingsFor("pat")).json()) as {
      orgPolicy: { importMinRole?: number }
    }
    expect(body.orgPolicy.importMinRole).toBe(500)
  })

  it("resolves the PROJECT_LEAD default for an out-of-ladder value", async () => {
    // Fail-safe: a misconfigured floor is a no-op, never a lockout.
    await seedProject({ importMinRole: 9999 })
    const body = (await (await settingsFor("pat")).json()) as {
      orgPolicy: { importMinRole?: number }
    }
    expect(body.orgPolicy.importMinRole).toBe(500)
  })
})
