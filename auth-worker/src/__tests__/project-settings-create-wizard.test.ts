// AQU-1250: project-create wizard must send one complete settings blob.
// The HTTP PATCH handler replaces the whole JSON (no per-key merge), so a
// second write carrying only targetLanes would silently wipe languages.
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

async function seedProjectWithoutSettings(): Promise<void> {
  await seedUser(1, "owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p-new', 'New', 1, 1)",
  ).run()
}

async function patchSettings(
  settings: Record<string, unknown>,
  ifMatchVersion = 0,
): Promise<Response> {
  return app.request(
    "/api/v2/projects/p-new/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("owner")),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p-new'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

describe("project-settings create-wizard blob (AQU-1250)", () => {
  it("stores sourceLanguage, targetLanguage, and targetLanes from one version-0 PATCH", async () => {
    await seedProjectWithoutSettings()

    const res = await patchSettings({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetLanes: ["es", "pt-BR"],
    })
    expect(res.status).toBe(200)

    const stored = await storedSettings()
    expect(stored.sourceLanguage).toBe("English")
    expect(stored.targetLanguage).toBe("French")
    expect(stored.targetLanes).toEqual(["es", "pt-BR"])
  })

  it("replaces the blob on PATCH — a follow-up write with only targetLanes drops languages", async () => {
    await seedProjectWithoutSettings()

    expect((await patchSettings({
      sourceLanguage: "English",
      targetLanguage: "French",
    })).status).toBe(200)

    const wipe = await patchSettings({ targetLanes: ["es"] }, 1)
    expect(wipe.status).toBe(200)

    const stored = await storedSettings()
    expect(stored.targetLanes).toEqual(["es"])
    expect(stored.sourceLanguage).toBeUndefined()
    expect(stored.targetLanguage).toBeUndefined()
  })
})
