// AQU-1771: changing a setting that moves the numbers on a Monday board marks
// that board's link dirty, so the cron flush pushes the new numbers without
// anyone editing the project. Pushes used to follow project activity only, so
// a board kept the old percentages after "headings count" or a validation
// count changed.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed() {
  await seedUser(1, "olive") // owner of both orgs
  await seedUser(2, "mara") // maintainer of org 1
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1), (2, 'Other', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1), (2,1,700,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('p-inherit', 'Genesis', 1, 1), ('p-over', 'Exodus', 1, 1), ('p-other', 'Ruth', 2, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-inherit', '{}', 1), ('p-over', ?, 1), ('p-other', '{}', 1)`,
  )
    .bind(JSON.stringify({ countStructuralCells: false }))
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by) VALUES
       ('c1', '1', 'monday', '{}', 'x', 'olive'), ('c2', '2', 'monday', '{}', 'x', 'olive')`,
  ).run()
  for (const [id, projectId, conn] of [
    ["l-inherit", "p-inherit", "c1"],
    ["l-over", "p-over", "c1"],
    ["l-other", "p-other", "c2"],
  ]) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, config, created_by)
       VALUES (?, ?, 'monday', ?, 'board', '{}', 'olive')`,
    )
      .bind(id, projectId, conn)
      .run()
  }
}

const dirtyLinks = async () =>
  ((
    await env.AQUILLA_PG.prepare(
      "SELECT id FROM integration_links WHERE dirty_at IS NOT NULL ORDER BY id",
    ).all<{ id: string }>()
  ).results ?? []).map((row) => row.id)

const patchProject = async (projectId: string, settings: Record<string, unknown>) =>
  app.request(
    `/api/v2/projects/${projectId}/settings`,
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("olive")),
      body: JSON.stringify({ settings, ifMatchVersion: 1 }),
    },
    env,
  )

const patchOrg = async (settings: Record<string, unknown>) =>
  app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("olive")),
      body: JSON.stringify({ settings, ifMatchVersion: 0 }),
    },
    env,
  )

describe("Monday boards follow settings changes (AQU-1771)", () => {
  it("a project's validation count change marks only that project's board", async () => {
    await seed()
    expect((await patchProject("p-inherit", { validationCount: 2 })).status).toBe(200)
    expect(await dirtyLinks()).toEqual(["l-inherit"])
  })

  it("a project's audio validation count change marks its board", async () => {
    await seed()
    expect((await patchProject("p-inherit", { validationCountAudio: 3 })).status).toBe(200)
    expect(await dirtyLinks()).toEqual(["l-inherit"])
  })

  it("a setting the board doesn't show leaves it alone", async () => {
    await seed()
    expect((await patchProject("p-inherit", { autoPropagateRepetitions: true })).status).toBe(200)
    expect(await dirtyLinks()).toEqual([])
  })

  it("the org's headings rule marks every board in that org and none in another", async () => {
    await seed()
    expect((await patchOrg({ countStructuralCells: false })).status).toBe(200)
    expect(await dirtyLinks()).toEqual(["l-inherit", "l-over"])
  })

  it("an org save that leaves the headings rule alone marks nothing", async () => {
    await seed()
    expect((await patchOrg({ orgTimezone: "UTC" })).status).toBe(200)
    expect(await dirtyLinks()).toEqual([])
  })

  it("clearing project overrides marks the boards of the projects it cleared", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/orgs/1/settings/count-structural/reset-project-overrides",
      { method: "POST", headers: authHeader(await jwtFor("olive")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await dirtyLinks()).toEqual(["l-over"])
  })
})
