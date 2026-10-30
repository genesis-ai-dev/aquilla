// AQU-2263 — "Auto-propagate repetitions" was the one org default on Project
// defaults with no "N projects set their own" line and no reset, because the
// server never counted the projects that set their own answer. It now counts
// them like every other default, and clears them on request.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const RESET = "/api/v2/orgs/1/settings/auto-propagate-repetitions/reset-project-overrides"

async function seed() {
  await seedUser(1, "olive") // org owner
  await seedUser(2, "mara")  // org maintainer
  await seedUser(3, "cora")  // contributor, no org role
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('p-off','Genesis',1,1), ('p-on','Exodus',1,1), ('p-inherit','Leviticus',1,1), ('p-archived','Old',1,1)`,
  ).run()
  await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = now() WHERE id = 'p-archived'").run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-off', ?, 3), ('p-on', ?, 2), ('p-inherit', ?, 1), ('p-archived', ?, 1)`,
  ).bind(
    JSON.stringify({ autoPropagateRepetitions: false, sourceLanguage: "en" }),
    JSON.stringify({ autoPropagateRepetitions: true }),
    JSON.stringify({ sourceLanguage: "en" }),
    JSON.stringify({ autoPropagateRepetitions: false }),
  ).run()
}

type SettingsBody = {
  autoPropagateRepetitionsOverrides?: number
  overrideProjects?: { autoPropagateRepetitions?: { total: number; projects: Array<{ id: string; name: string }> } }
}

const getSettings = async (who: string) =>
  (await (await app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(who)) }, env)).json()) as SettingsBody

const storedFor = async (projectId: string) =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = ?")
      .bind(projectId).first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

describe("org settings counts the projects that set their own repetition answer", () => {
  it("counts both directions, and names them, but not archived projects", async () => {
    await seed()
    const body = await getSettings("mara")
    expect(body.autoPropagateRepetitionsOverrides).toBe(2)
    expect(body.overrideProjects?.autoPropagateRepetitions).toEqual({
      total: 2,
      projects: [{ id: "p-on", name: "Exodus" }, { id: "p-off", name: "Genesis" }],
    })
  })
})

describe("putting those projects back on the organization's answer", () => {
  it("removes the key from each, and leaves the rest of the project alone", async () => {
    await seed()
    const res = await app.request(RESET, { method: "POST", headers: authHeader(await jwtFor("mara")) }, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cleared: number }).cleared).toBe(2)
    const off = await storedFor("p-off")
    expect("autoPropagateRepetitions" in off).toBe(false)
    expect(off.sourceLanguage).toBe("en")
    expect("autoPropagateRepetitions" in (await storedFor("p-on"))).toBe(false)
    expect((await storedFor("p-archived")).autoPropagateRepetitions).toBe(false)
    expect((await getSettings("mara")).autoPropagateRepetitionsOverrides).toBe(0)
  })

  it("is refused below the gate that sets the default itself", async () => {
    await seed()
    const res = await app.request(RESET, { method: "POST", headers: authHeader(await jwtFor("cora")) }, env)
    expect(res.status).toBe(403)
    expect((await storedFor("p-off")).autoPropagateRepetitions).toBe(false)
  })
})
