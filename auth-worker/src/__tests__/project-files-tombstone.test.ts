import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

async function seedWorld() {
  await seedUser(1, "owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Alpha', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files
       (id, project_id, name, kind, event_id, cell_count, approved_count, word_count, last_edit_at, deleted_at, meta)
     VALUES
       ('active-file', 'proj1', 'mapped.csv', 'csv', 'evt-active', 10, 2, 100, 1000, NULL,
        '{"aquillaImport":{"hasScriptureContent":true}}'),
       ('deleted-file', 'proj1', 'EXO', 'usfm', 'evt-deleted', 8, 1, 80, 900, 1234, '{}')`,
  ).run()
}

describe("GET /api/v2/projects file list tombstones", () => {
  beforeEach(async () => {
    await seedWorld()
  })

  it("excludes soft-deleted files from the project list endpoint", async () => {
    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string; files: Array<{ id: string }> }>
    }
    expect(body.projects.find((project) => project.id === "proj1")?.files.map((file) => file.id))
      .toEqual(["active-file"])
  })

  it("surfaces the content-derived Scripture capability without changing file type", async () => {
    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string; files: Array<{ id: string; type: string; hasScriptureContent?: boolean }> }>
    }
    expect(body.projects.find((project) => project.id === "proj1")?.files[0]).toMatchObject({
      id: "active-file",
      type: "csv",
      hasScriptureContent: true,
    })
  })

  it("excludes soft-deleted files from the single-project endpoint", async () => {
    const res = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: Array<{ id: string }> }
    expect(body.files.map((file) => file.id)).toEqual(["active-file"])
  })
})
