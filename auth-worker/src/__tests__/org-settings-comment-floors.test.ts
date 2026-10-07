// Tests for the comment floors in the org-settings PATCH route (AQU-1002).
// Mirrors org-settings-termbase-floor.test.ts — both keys join the same
// PERMISSION_POLICY_KEYS loop, so they inherit role-ladder validation and the
// OWNER-only write gate without any bespoke code to test.
//
// Verifies:
//   1. An org owner (700) can set each floor.
//   2. A maintainer (600) trying to CHANGE either -> 403 (owner-only keys).
//   3. A maintainer echoing unchanged values still writes (the
//      read-modify-write client must not be locked out of all settings).
//   4. Garbage values (450 / "contributor") -> 400.
//   5. The two floors are independent — setting one leaves the other alone.
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

describe("org-settings PATCH comment floors (AQU-1002)", () => {
  it("lets an owner (700) set both floors", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("alice"), {
      commentCreateMinRole: 400,
      commentResolveMinRole: 600,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      settings: { commentCreateMinRole?: number; commentResolveMinRole?: number }
    }
    expect(body.settings.commentCreateMinRole).toBe(400)
    expect(body.settings.commentResolveMinRole).toBe(600)
  })

  it("keeps the two floors independent", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("alice"), { commentResolveMinRole: 200 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      settings: { commentCreateMinRole?: number; commentResolveMinRole?: number }
    }
    expect(body.settings.commentResolveMinRole).toBe(200)
    // Unset stays unset — the reader applies the COMMENTER default.
    expect(body.settings.commentCreateMinRole).toBeUndefined()
  })

  it("403s when a maintainer (600) tries to change either floor", async () => {
    await seed()
    const jwt = await jwtFor("bob")

    const createRes = await patchSettings(jwt, { commentCreateMinRole: 400 })
    expect(createRes.status).toBe(403)
    const createBody = (await createRes.json()) as { error: string }
    expect(createBody.error).toMatch(/owner/)
    expect(createBody.error).toMatch(/commentCreateMinRole/)

    const resolveRes = await patchSettings(jwt, { commentResolveMinRole: 600 })
    expect(resolveRes.status).toBe(403)
    const resolveBody = (await resolveRes.json()) as { error: string }
    expect(resolveBody.error).toMatch(/commentResolveMinRole/)
  })

  it("lets a maintainer echo the unchanged floors (read-modify-write client)", async () => {
    await seed('{"commentCreateMinRole":400,"commentResolveMinRole":600}')
    const res = await patchSettings(await jwtFor("bob"), {
      commentCreateMinRole: 400,
      commentResolveMinRole: 600,
      rules: [],
    })
    expect(res.status).toBe(200)
  })

  it("400s on values that are not role-ladder levels", async () => {
    await seed()
    const jwt = await jwtFor("alice")

    const offLadder = await patchSettings(jwt, { commentCreateMinRole: 450 })
    expect(offLadder.status).toBe(400)

    const notANumber = await patchSettings(jwt, { commentResolveMinRole: "contributor" })
    expect(notANumber.status).toBe(400)
    const body = (await notANumber.json()) as { error: string }
    expect(body.error).toMatch(/commentResolveMinRole/)
  })
})
