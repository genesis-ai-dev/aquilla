// AQU-2549: a project that already had its own import of an upstream file.
//
// On a call with Biblica, a lead linked the corrected "Genesis–Deuteronomy" from
// the BSB source project into a language project that had imported the file on
// its own. These tests pin the server half of the fixes:
//
//   - "Join into my existing file": a copy the link already mirrored in is
//     joined into the project's own file (part 1). The route records the pair
//     the sync joins (the sync half is in sync-worker link-sync-join-copy.test.ts).
//   - While the source project's import of the file is still running, the file
//     is staged (soft-deleted until it publishes). The comparison said "only 0
//     of 0 lines match"; it now says the file is still importing.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { deterministicDownstreamFileId } from "../services/source-linking"

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

/** Each project's real source and target lane; the test lane filler is off. */
const sourceLane = (projectId: string): string => `${projectId}-src`
const targetLane = (projectId: string): string => `${projectId}-tgt`

async function seedProjectWithLead(projectId: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(projectId, name)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
     VALUES (?, ?, 'source', 'English', NULL, 0), (?, ?, 'target', 'Portuguese', '', 1)`,
  )
    .bind(sourceLane(projectId), projectId, targetLane(projectId), projectId)
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
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, anchor_cell_id, event_id, last_edit_at, lane_id)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 2000, ?)`,
    )
      .bind(
        projectId, fileId, `${cellPrefix}-${i + 1}`, lines[i], i === 0 ? null : `${cellPrefix}-${i}`,
        `e-${fileId}-${i + 1}`, sourceLane(projectId),
      )
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
  await env.AQUILLA_PG.prepare("SELECT set_config('aquilla.test_lane_fill', 'off', false)").first()
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

describe("Join into my existing file (AQU-2549 part 1)", () => {
  const COPY_GD = deterministicDownstreamFileId(DOWN, UP_GD)

  /** A whole-project live link that has mirrored the upstream file in as a copy. */
  async function linkedWithCopy(copyLines: readonly string[] = LINES): Promise<void> {
    await env.AQUILLA_PG.prepare(
      `UPDATE projects SET source_project_id = ?, source_link_mode = 'live', source_link_consumes = 'source',
              source_link_gate = 'validated', source_link_cursor = 10 WHERE id = ?`,
    )
      .bind(UP, DOWN)
      .run()
    await seedFile(DOWN, COPY_GD, "3 Genesis–Deuteronomy", "up", copyLines)
  }

  async function adoptRaw(): Promise<string | null> {
    const row = await env.AQUILLA_PG.prepare("SELECT source_link_adopt FROM projects WHERE id = ?")
      .bind(DOWN)
      .first<{ source_link_adopt: string | null }>()
    return row?.source_link_adopt ?? null
  }

  async function copies(): Promise<Response> {
    return app.request(
      `/api/v2/projects/${DOWN}/link-source/copies`,
      { headers: authHeader(await jwtFor("lead")) },
      env,
    )
  }

  // WHY: Joel's project held two "Genesis–Deuteronomy" files after a
  // whole-project link and nothing could put the corrected source onto the one
  // his team translated.
  it("lists the copy with the same-named own file, and records the join the sync performs", async () => {
    await linkedWithCopy()

    const listed = await copies()
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      copies: [{ fileId: COPY_GD, upstreamFileId: UP_GD, translated: false, suggestedFileId: OWN_GD }],
      ownFiles: [{ id: OWN_GD, name: "3 Genesis–Deuteronomy" }],
    })

    const res = await post("/link-source/join", { copyFileId: COPY_GD, fileId: OWN_GD })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ match: { same: 4, canReplace: true } })
    expect(JSON.parse((await adoptRaw())!)).toEqual({ files: { [UP_GD]: OWN_GD }, pending: [UP_GD] })
  })

  // WHY (Sam's pick, Nov 14): joining would leave the copy's own translations
  // on a deleted file. Refused, and the reason is said.
  it("refuses a copy that has translations of its own", async () => {
    await linkedWithCopy()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id)
       VALUES (?, ?, 'up-2', 'target', 'No princípio', 'e-t-1', 3000, ?)`,
    )
      .bind(DOWN, COPY_GD, targetLane(DOWN))
      .run()

    const res = await post("/link-source/join", { copyFileId: COPY_GD, fileId: OWN_GD })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "copyHasTranslations" })
    expect(await adoptRaw()).toBeNull()
  })

  // WHY: the half-the-lines check every replace makes still holds.
  it("refuses two files that are not the same material", async () => {
    await linkedWithCopy()
    await env.AQUILLA_PG.prepare("DELETE FROM cells WHERE project_id = ? AND file_id = ?").bind(DOWN, OWN_GD).run()
    await seedFile(DOWN, "file-2549-other", "Psalms", "ps", ["Psalm 1", "Blessed is the man", "who does not walk", "Selah"])

    const res = await post("/link-source/join", { copyFileId: COPY_GD, fileId: "file-2549-other" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ match: { canReplace: false } })
    expect(await adoptRaw()).toBeNull()
  })

  // WHY: a file the project imported itself is not a copy; "joining" it would
  // delete the team's own file.
  it("refuses a file that is not a copy from the source project", async () => {
    await linkedWithCopy()
    const res = await post("/link-source/join", { copyFileId: OWN_GD, fileId: COPY_GD })
    expect(res.status).toBe(404)
    expect(await adoptRaw()).toBeNull()
  })

  // WHY (review finding 4, pick: a stopped file stays stopped): a copy of a file
  // the lead stopped following no longer gets the source's updates, and
  // joining it would quietly start following the file again.
  it("does not offer the copy of a file the lead stopped following", async () => {
    await linkedWithCopy()
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_link_file_ids = ? WHERE id = ?")
      .bind(JSON.stringify(["file-2549-up-other"]), DOWN)
      .run()
    const listed = await copies()
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { copies: unknown[]; ownFiles: Array<{ id: string }> }
    expect(body.copies).toEqual([])
    expect(body.ownFiles.map((f) => f.id)).toEqual([OWN_GD])

    const res = await post("/link-source/join", { copyFileId: COPY_GD, fileId: OWN_GD })
    expect(res.status).toBe(404)
    expect(await adoptRaw()).toBeNull()
  })

  it("is for a Project Lead or higher", async () => {
    await linkedWithCopy()
    await seedUser(2, "translator")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 300, 1)",
    )
      .bind(DOWN)
      .run()
    const res = await app.request(
      `/api/v2/projects/${DOWN}/link-source/join`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("translator")),
        body: JSON.stringify({ copyFileId: COPY_GD, fileId: OWN_GD }),
      },
      env,
    )
    expect(res.status).toBe(403)
    expect(await adoptRaw()).toBeNull()
  })
})
