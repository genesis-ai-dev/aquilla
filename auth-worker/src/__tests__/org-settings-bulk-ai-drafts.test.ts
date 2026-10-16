// Who may let bulk text validation sign off untouched AI drafts (Sam,
// 2026-10-01). Like countStructuralCells, and unlike the keys in
// PERMISSION_POLICY_KEYS, this is not a permission policy — it widens what one
// validate gesture covers, not who may validate — so it rides the general
// maintainer gate and is only type-checked. Mirrors
// settings-count-structural.test.ts.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrg() {
  await seedUser(1, "olive") // owner
  await seedUser(2, "mara")  // maintainer
  await seedUser(3, "leo")   // project lead
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1), (1,3,500,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

const patchOrg = async (jwt: string, settings: Record<string, unknown>) =>
  app.request(
    "/api/v2/orgs/1/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify({ settings, ifMatchVersion: 0 }) },
    env,
  )

const storedOrg = async () =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM org_settings WHERE org_id = 1")
      .first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

describe("org: allowBulkValidateAiDrafts is a maintainer setting", () => {
  it("lets a maintainer turn it on", async () => {
    await seedOrg()
    const res = await patchOrg(await jwtFor("mara"), { allowBulkValidateAiDrafts: true })
    expect(res.status).toBe(200)
    expect((await storedOrg()).allowBulkValidateAiDrafts).toBe(true)
  })

  it("lets an owner turn it on too", async () => {
    await seedOrg()
    const res = await patchOrg(await jwtFor("olive"), { allowBulkValidateAiDrafts: true })
    expect(res.status).toBe(200)
  })

  it("403s an org member below maintainer", async () => {
    await seedOrg()
    const res = await patchOrg(await jwtFor("leo"), { allowBulkValidateAiDrafts: true })
    expect(res.status).toBe(403)
    expect((await storedOrg()).allowBulkValidateAiDrafts).toBeUndefined()
  })

  it("400s a non-boolean rather than storing it", async () => {
    // "true" as a string would read as OFF in the client (`=== true`) with
    // nothing on screen to say why the setting did not take.
    await seedOrg()
    const res = await patchOrg(await jwtFor("mara"), { allowBulkValidateAiDrafts: "true" })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/allowBulkValidateAiDrafts must be a boolean/)
  })
})
