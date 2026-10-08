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

describe("project-settings create-wizard blob (AQU-1250 / AQU-1595)", () => {
  it("rejects a version-0 PATCH that includes the retired language keys", async () => {
    await seedProjectWithoutSettings()

    const res = await patchSettings({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetLanes: ["es", "pt-BR"],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/not settings/)
    expect(await storedSettings()).toEqual({})
  })

  it("stores other settings and does not invent the retired keys", async () => {
    await seedProjectWithoutSettings()

    const res = await patchSettings({ systemPrompt: "be terse" })
    expect(res.status).toBe(200)
    expect(await storedSettings()).toEqual({ systemPrompt: "be terse" })
  })
})
