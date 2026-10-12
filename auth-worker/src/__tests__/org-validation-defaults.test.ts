// AQU-1771 — org defaults for how many validations a cell (validationCount)
// and a take (validationCountAudio) need. The org sets a default; a project
// may override it; absent on both reads as 1. Modelled on countStructuralCells
// (org-count-structural-overrides.test.ts).
//
// The text threshold is PROJECTED into cells.validated and files.approved_count,
// so moving the org default must re-derive those for the projects that
// inherit it, and leave the projects that override it alone.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

afterEach(() => {
  vi.restoreAllMocks()
})

async function seed() {
  await seedUser(1, "olive") // org owner
  await seedUser(2, "mara")  // org maintainer
  await seedUser(3, "pete")  // project lead, no org role
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
       ('p-over','Genesis',1,1), ('p-inherit','Exodus',1,1), ('p-norow','Levit',1,1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-over', ?, 3),
       ('p-inherit', ?, 1)`,
  ).bind(
    JSON.stringify({ validationCount: 1, validationCountAudio: 1 }),
    JSON.stringify({ sourceLanguage: "en" }),
  ).run()
  // One target cell with ONE validator in each project.
  for (const projectId of ["p-over", "p-inherit", "p-norow"]) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'target', 'French', 'fr', 'fr', 1)`,
    ).bind(`lane-${projectId}`, projectId).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO files (id, project_id, name, event_id) VALUES (?, ?, 'F', 'e-file')",
    ).bind(`f-${projectId}`, projectId).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, validated, lane_id)
       VALUES (?, ?, 'c1', 'target', 'text', 'e-edit', 1, 1, ?)`,
    ).bind(projectId, `f-${projectId}`, `lane-${projectId}`).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_validators (project_id, file_id, cell_id, lane_id, event_id, username, decided_ts)
       VALUES (?, ?, 'c1', ?, 'e-edit', 'bob', 1)`,
    ).bind(projectId, `f-${projectId}`, `lane-${projectId}`).run()
    await env.AQUILLA_PG.prepare("UPDATE files SET approved_count = 1 WHERE id = ?")
      .bind(`f-${projectId}`).run()
  }
}

const patchOrg = async (who: string, settings: Record<string, unknown>, ifMatchVersion = 0) =>
  app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(who)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )

const getOrg = async (who: string) =>
  app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(who)) }, env)

const validated = async (projectId: string) => {
  const cell = await env.AQUILLA_PG.prepare(
    "SELECT validated FROM cells WHERE project_id = ? AND cell_id = 'c1'",
  ).bind(projectId).first<{ validated: number }>()
  const file = await env.AQUILLA_PG.prepare(
    "SELECT approved_count FROM files WHERE project_id = ?",
  ).bind(projectId).first<{ approved_count: number }>()
  return { cell: Number(cell?.validated), approved: Number(file?.approved_count) }
}

describe("AQU-1771: org validation defaults", () => {
  it("rejects a value that is not a whole number from 1 to 15", async () => {
    await seed()
    for (const bad of [0, 16, 1.5, "2"]) {
      const res = await patchOrg("mara", { validationCount: bad })
      expect(res.status, String(bad)).toBe(400)
    }
    expect((await patchOrg("mara", { validationCountAudio: 0 })).status).toBe(400)
  })

  it("a maintainer may set them (not an owner-only policy)", async () => {
    await seed()
    const res = await patchOrg("mara", { validationCount: 2, validationCountAudio: 3 })
    expect(res.status).toBe(200)
  })

  it("raising the org default re-projects only the projects that inherit it", async () => {
    await seed()
    expect((await patchOrg("mara", { validationCount: 2 })).status).toBe(200)
    // One validator no longer meets 2 where the project inherits…
    expect(await validated("p-inherit")).toEqual({ cell: 0, approved: 0 })
    expect(await validated("p-norow")).toEqual({ cell: 0, approved: 0 })
    // …and the project that set 1 for itself is untouched.
    expect(await validated("p-over")).toEqual({ cell: 1, approved: 1 })

    // Lowering it again brings them back.
    expect((await patchOrg("mara", { validationCount: 1 }, 1)).status).toBe(200)
    expect(await validated("p-inherit")).toEqual({ cell: 1, approved: 1 })
  })

  it("reports how many projects override each default", async () => {
    await seed()
    const body = (await (await getOrg("mara")).json()) as {
      validationCountOverrides: number
      validationCountAudioOverrides: number
    }
    expect(body.validationCountOverrides).toBe(1)
    expect(body.validationCountAudioOverrides).toBe(1)
  })

  it("a save and a version clash carry the override counts too, not only the GET", async () => {
    // The client replaces its whole copy with each response; without the
    // counts the reset prompt read "no overrides" after the first save.
    await seed()
    const saved = await patchOrg("mara", { validationCount: 2 })
    expect(saved.status).toBe(200)
    const body = (await saved.json()) as {
      countStructuralOverrides: number
      validationCountOverrides: number
      validationCountAudioOverrides: number
    }
    expect(body.validationCountOverrides).toBe(1)
    expect(body.validationCountAudioOverrides).toBe(1)
    expect(typeof body.countStructuralOverrides).toBe("number")

    const clash = await patchOrg("mara", { validationCount: 3 }, 0)
    expect(clash.status).toBe(409)
    const current = ((await clash.json()) as { current: { validationCountOverrides: number } }).current
    expect(current.validationCountOverrides).toBe(1)
  })

  it("reset clears the project overrides and re-projects those projects at the org value", async () => {
    await seed()
    expect((await patchOrg("mara", { validationCount: 2 })).status).toBe(200)
    expect(await validated("p-over")).toEqual({ cell: 1, approved: 1 })

    const res = await app.request(
      "/api/v2/orgs/1/settings/validation-count/reset-project-overrides",
      { method: "POST", headers: authHeader(await jwtFor("mara")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cleared: number }).cleared).toBe(1)
    const stored = JSON.parse(
      (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = 'p-over'")
        .first<{ settings: string }>())!.settings,
    ) as Record<string, unknown>
    expect(stored.validationCount).toBeUndefined()
    // The audio override is a different key and stays.
    expect(stored.validationCountAudio).toBe(1)
    expect(await validated("p-over")).toEqual({ cell: 0, approved: 0 })
  })

  it("an unknown reset slug is refused", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/orgs/1/settings/rules/reset-project-overrides",
      { method: "POST", headers: authHeader(await jwtFor("mara")) },
      env,
    )
    expect(res.status).toBe(404)
  })

  it("the project settings response carries the org defaults", async () => {
    await seed()
    await patchOrg("mara", { validationCount: 2, validationCountAudio: 3 })
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p-inherit', 3, 500, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/p-inherit/settings",
      { headers: authHeader(await jwtFor("pete")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orgValidationCount: number | null; orgValidationCountAudio: number | null }
    expect(body.orgValidationCount).toBe(2)
    expect(body.orgValidationCountAudio).toBe(3)
  })

  it("clearing a project's own value falls back to the org default", async () => {
    await seed()
    await patchOrg("mara", { validationCount: 2 })
    // p-over set 1 for itself; drop it.
    const res = await app.request(
      "/api/v2/projects/p-over/settings",
      {
        method: "PUT",
        headers: authHeader(await jwtFor("mara")),
        body: JSON.stringify({ settings: { validationCountAudio: 1 }, ifMatchVersion: 3 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await validated("p-over")).toEqual({ cell: 0, approved: 0 })
  })
})
