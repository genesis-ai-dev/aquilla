// AQU-2549: a project that already had its own import of an upstream file.
//
// On a call with Biblica, a lead linked the corrected "Genesis–Deuteronomy" from
// the BSB source project into a language project that had imported the file on
// its own. These tests pin the server half of the fixes:
//
//   - While the source project's import of the file is still running, the file
//     is staged (soft-deleted until it publishes). The comparison said "only 0
//     of 0 lines match"; it now says the file is still importing.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const DOWN = "proj-2549-portuguese"
const UP = "proj-2549-bsb"
const UP_GD = "file-2549-up-gd"
const OWN_GD = "file-2549-own-gd"

const LINES = [
  "Genesis",
  "In the beginning God created the heavens and the earth.",
  "Mesopotamia: the region of modern Iraq, Iran and Syria.",
  "So Abram departed, as the LORD had directed him.",
]

async function seedProjectWithLead(projectId: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(projectId, name)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 1, 500, 1)",
  )
    .bind(projectId)
    .run()
}

async function seedFile(
  projectId: string,
  fileId: string,
  name: string,
  cellPrefix: string,
  lines: readonly string[],
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, '{}')`,
  )
    .bind(fileId, projectId, name, `e-${fileId}`)
    .run()
  for (let i = 0; i < lines.length; i++) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, anchor_cell_id, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 2000)`,
    )
      .bind(projectId, fileId, `${cellPrefix}-${i + 1}`, lines[i], i === 0 ? null : `${cellPrefix}-${i}`, `e-${fileId}-${i + 1}`)
      .run()
  }
}

let seq = 0
async function event(projectId: string, fileId: string, kind: string, clientTs: number): Promise<void> {
  seq += 1
  await env.AQUILLA_PG.prepare(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES (?, 1, ?, ?, NULL, NULL, ?, 'joel', '{}', ?, ?, ?)`,
  )
    .bind(`ev-2549-${seq}`, projectId, fileId, kind, clientTs, clientTs + seq, seq)
    .run()
}

/** The upstream file as /import's first chunk leaves it: created and staged
 *  (a `file.delete` in the same request) until the import publishes. */
async function stageUpstreamImport(): Promise<void> {
  await event(UP, UP_GD, "file.create", 5000)
  await event(UP, UP_GD, "file.delete", 5000)
  await env.AQUILLA_PG.prepare("UPDATE files SET deleted_at = 5001 WHERE id = ?").bind(UP_GD).run()
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}${path}`,
    { method: "POST", headers: authHeader(await jwtFor("lead")), body: JSON.stringify(body) },
    env,
  )
}

async function match(): Promise<Record<string, unknown>> {
  const res = await post("/link-source/match", {
    sourceProjectId: UP,
    files: [{ upstreamFileId: UP_GD, fileId: OWN_GD }],
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { files: Array<Record<string, unknown>> }).files[0]
}

beforeEach(async () => {
  seq = 0
  await seedUser(1, "lead")
  await seedProjectWithLead(DOWN, "BSB Portuguese")
  await seedProjectWithLead(UP, "BSB source")
  await seedFile(UP, UP_GD, "3 Genesis–Deuteronomy", "up", LINES)
  await seedFile(DOWN, OWN_GD, "3 Genesis–Deuteronomy", "own", LINES)
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ranSync: true }), { status: 200 }))
})

describe("POST /link-source/match while the source project is still importing the file (AQU-2549 part 3)", () => {
  // WHY: Joel's link button "failed until the upload settled", and the only
  // words on screen were "only 0 of 0 lines match", which reads as "these are
  // different files". A staged import is a wait, not a mismatch.
  it("says the upstream file is still importing instead of reporting 0 of 0 lines", async () => {
    await stageUpstreamImport()
    const staged = await match()
    expect(staged).toMatchObject({ missing: true, importing: true, canReplace: false })

    // Published: the reveal restores the row, and the comparison is a real one.
    await event(UP, UP_GD, "file.restore", 6000)
    await env.AQUILLA_PG.prepare("UPDATE files SET deleted_at = NULL WHERE id = ?").bind(UP_GD).run()
    const published = await match()
    expect(published).toMatchObject({ missing: false, canReplace: true, same: 4 })
    expect(published).not.toHaveProperty("importing")
  })

  // WHY: a file someone deleted is not "still importing"; saying so would have
  // the lead wait for something that never comes.
  it("does not call a deleted upstream file importing", async () => {
    await event(UP, UP_GD, "file.create", 5000)
    await event(UP, UP_GD, "file.delete", 9000)
    await env.AQUILLA_PG.prepare("UPDATE files SET deleted_at = 9001 WHERE id = ?").bind(UP_GD).run()
    const deleted = await match()
    expect(deleted).toMatchObject({ missing: true, canReplace: false })
    expect(deleted).not.toHaveProperty("importing")
  })
})
