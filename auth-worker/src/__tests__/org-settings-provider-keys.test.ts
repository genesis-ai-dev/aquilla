// FRO-433 — Org-level provider key storage via org-settings route.
//
// Verifies:
//   1. A maintainer (600) can write orgProviderKeys into the settings blob.
//   2. A contributor (400) is blocked (below MAINTAINER gate).
//   3. A GET returns the orgProviderKeys that were written.
//   4. Clearing the key (undefined/omitted) works without error.
//   5. orgProviderKeys is orthogonal to exportMinRole — writing keys
//      does NOT interfere with the export floor.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrg() {
  await seedUser(1, "wendi")  // owner (700)
  await seedUser(2, "anna")   // maintainer (600)
  await seedUser(3, "tom")    // contributor (400)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Aquilla Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1),
      (1, 2, 600, 1),
      (1, 3, 400, 1)`,
  ).run()
  // Pre-seed settings row at version 0.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

const patch = async (
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 0,
): Promise<Response> =>
  app.request("/api/v2/orgs/1/settings", {
    method: "PATCH",
    headers: authHeader(await jwtFor(username)),
    body: JSON.stringify({ settings, ifMatchVersion }),
  }, env)

const get = async (username: string): Promise<Response> =>
  app.request("/api/v2/orgs/1/settings", {
    headers: authHeader(await jwtFor(username)),
  }, env)

describe("org-settings orgProviderKeys (FRO-433)", () => {
  it("maintainer (600) can store orgProviderKeys", async () => {
    await seedOrg()
    const res = await patch("anna", {
      orgProviderKeys: { "gemini-tts": "AIza-test-key" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown>; version: number }
    expect(body.version).toBe(1)
    const keys = body.settings.orgProviderKeys as Record<string, unknown>
    expect(keys["gemini-tts"]).toBe("AIza-test-key")
  })

  it("owner (700) can store orgProviderKeys", async () => {
    await seedOrg()
    const res = await patch("wendi", {
      orgProviderKeys: { "gemini-tts": "AIza-owner-key" },
    })
    expect(res.status).toBe(200)
  })

  it("contributor (400) cannot write (403)", async () => {
    await seedOrg()
    const res = await patch("tom", {
      orgProviderKeys: { "gemini-tts": "AIza-should-fail" },
    })
    // contributor is below MAINTAINER (600) gate
    expect(res.status).toBe(403)
  })

  it("GET returns orgProviderKeys after write", async () => {
    await seedOrg()
    await patch("anna", { orgProviderKeys: { "gemini-tts": "stored-key" } })
    const res = await get("anna")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown> }
    const keys = body.settings.orgProviderKeys as Record<string, unknown>
    expect(keys["gemini-tts"]).toBe("stored-key")
  })

  it("clearing the key (setting to undefined/omitting) works", async () => {
    await seedOrg()
    // First set a key.
    await patch("anna", { orgProviderKeys: { "gemini-tts": "key-to-clear" } })
    // Read version after first write.
    const readRes = await get("wendi")
    const { version } = (await readRes.json()) as { version: number }
    // Clear: write the settings without any orgProviderKeys.
    const clearRes = await patch("anna", {}, version)
    expect(clearRes.status).toBe(200)
    const clearBody = (await clearRes.json()) as { settings: Record<string, unknown> }
    // orgProviderKeys should be absent from the blob.
    expect(clearBody.settings.orgProviderKeys).toBeUndefined()
  })

  it("orgProviderKeys write does not disturb exportMinRole", async () => {
    await seedOrg()
    // Owner sets exportMinRole first.
    await patch("wendi", { exportMinRole: 400 })
    const readRes = await get("wendi")
    const { settings: s1, version: v1 } = (await readRes.json()) as {
      settings: Record<string, unknown>; version: number
    }
    expect(s1.exportMinRole).toBe(400)
    // Maintainer writes orgProviderKeys (echoes exportMinRole per the
    // read-modify-write pattern in patchOrgSettings client-side, but here
    // we verify server is neutral — a different settings blob coexists fine).
    const mergeRes = await patch("anna", {
      exportMinRole: 400,
      orgProviderKeys: { "gemini-tts": "another-key" },
    }, v1)
    expect(mergeRes.status).toBe(200)
    const body2 = (await mergeRes.json()) as { settings: Record<string, unknown> }
    expect(body2.settings.exportMinRole).toBe(400)
    expect((body2.settings.orgProviderKeys as Record<string, unknown>)["gemini-tts"]).toBe("another-key")
  })
})
