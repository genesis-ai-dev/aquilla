import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrgWithDeletedFiles() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(9, "outsider")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES
      ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1),
      ('e2', 1, 'pa', 'file.create', 'wendi', '{}', 2000, 2000, 2),
      ('e3', 1, 'pb', 'file.create', 'wendi', '{}', 500, 500, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, event_id, cell_count, deleted_at) VALUES
      ('f-live', 'pa', 'GEN.usfm', 'e1', 10, NULL),
      ('f-del-a', 'pa', 'EXO.usfm', 'e2', 20, 1700000000000),
      ('f-del-b', 'pb', 'MRK.usfm', 'e3', 30, 1700000100000)`,
  ).run()
}

describe("GET /api/v2/orgs/:orgId/deleted-files", () => {
  it("returns tombstoned files with project names, newest first", async () => {
    await seedOrgWithDeletedFiles()
    const res = await app.request(
      "/api/v2/orgs/1/deleted-files",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      files: Array<{
        fileId: string
        name: string
        projectId: string
        projectName: string
        cellCount: number
        deletedAt: number
      }>
    }
    expect(body.files.map((f) => f.fileId)).toEqual(["f-del-b", "f-del-a"])
    expect(body.files[0]).toMatchObject({
      name: "MRK.usfm",
      projectId: "pb",
      projectName: "Mark",
      cellCount: 30,
      deletedAt: 1700000100000,
    })
    expect(body.files[1]).toMatchObject({
      name: "EXO.usfm",
      projectId: "pa",
      projectName: "John",
    })
  })

  it("hides files in projects a regular member cannot see", async () => {
    await seedOrgWithDeletedFiles()
    const res = await app.request(
      "/api/v2/orgs/1/deleted-files",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: Array<{ fileId: string }> }
    expect(body.files.map((f) => f.fileId)).toEqual(["f-del-a"])
  })

  it("403s a non-member", async () => {
    await seedOrgWithDeletedFiles()
    const denied = await app.request(
      "/api/v2/orgs/1/deleted-files",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(denied.status).toBe(403)
  })
})
